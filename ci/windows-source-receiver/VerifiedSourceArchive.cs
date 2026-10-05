using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace GongdeSourceReceiver {
  public sealed class ReceiverFault : Exception {
    public string Code { get; private set; }
    public ReceiverFault(string code) : base(code) { Code = code; }
  }
  public sealed class VerifiedEntry {
    public string Path { get; set; }
    public byte[] Bytes { get; set; }
  }
  public sealed class ArchivePlan {
    public List<VerifiedEntry> Entries { get; set; }
  }
  public static class ArchiveVerifier {
    public const int ArchiveBytes = 760923;
    public const string ArchiveSha = "0029f5e9fdd8b88adeff94a45c009afc70c061ee9dd83f4107e29148a07632fa";
    public const string ManifestSha = "c02e32da628429414382efdf4b60c3b79bfdd518e257558db9d026231d80000a";
    private static readonly string[] SourceNames = {
      "CMakeLists.txt",
      "VERSION",
      "src/windows/app.cpp",
      "src/windows/appearance_pack.cpp",
      "src/windows/appearance_pack.h",
      "src/windows/appearance_pack_test.cpp",
      "src/windows/app.rc",
      "src/windows/app.manifest",
      "third_party/miniz/miniz.c",
      "third_party/miniz/miniz.h",
      "third_party/miniz/LICENSE",
      "assets/woodfish.png",
      "assets/mallet.png",
      "assets/appicon.ico",
      "installer/windows/niuma-merit.iss",
      "scripts/build-windows.ps1",
      "scripts/verify-windows-artifact.ps1",
      "scripts/test-windows-installed-community-gui.ps1",
      "scripts/test-windows-startup-lifecycle.py",
      "handoff/build-and-accept.ps1",
      "handoff/sdk-manifest.template.json"
    };
    private sealed class Central {
      public string Name; public uint Crc; public ulong Size, Packed, Offset;
      public ushort Flags, Method;
    }
    private static void Need(bool ok, string code) { if (!ok) throw new ReceiverFault(code); }
    public static string Sha(byte[] bytes) {
      using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
    private static void Bounds(byte[] b, long p, long n) {
      Need(p >= 0 && n >= 0 && p <= b.LongLength && n <= b.LongLength - p, "ZIP_BOUNDS");
    }
    private static ushort U16(byte[] b, long p) { Bounds(b,p,2); return BitConverter.ToUInt16(b,(int)p); }
    private static uint U32(byte[] b, long p) { Bounds(b,p,4); return BitConverter.ToUInt32(b,(int)p); }
    private static ulong U64(byte[] b, long p) { Bounds(b,p,8); return BitConverter.ToUInt64(b,(int)p); }
    public static void SafeName(string name) {
      Need(!String.IsNullOrEmpty(name) && name.Length <= 240 &&
        name.All(c => c >= 33 && c <= 126) && !name.Contains("\\") && !name.Contains(":") &&
        !name.StartsWith("/") && !name.EndsWith("/"), "ZIP_PATH");
      foreach (var part in name.Split('/')) {
        Need(part.Length > 0 && part != "." && part != ".." && !part.EndsWith(".") &&
          !part.EndsWith(" "), "ZIP_PATH");
        string stem = part.Split('.')[0].ToUpperInvariant();
        Need(stem != "CON" && stem != "PRN" && stem != "AUX" && stem != "NUL" &&
          !(stem.Length == 4 && (stem.StartsWith("COM") || stem.StartsWith("LPT")) &&
            stem[3] >= '1' && stem[3] <= '9'), "ZIP_RESERVED_NAME");
      }
    }
    private static string Name(byte[] b, int p, int n) {
      Bounds(b,p,n);
      for (int i = p; i < p+n; i++) Need(b[i] >= 33 && b[i] <= 126, "ZIP_ENCODING");
      string name = Encoding.ASCII.GetString(b,p,n); SafeName(name); return name;
    }
    private static Dictionary<string,Central> CentralDirectory(byte[] b) {
      int end = -1;
      for (int p = b.Length-22; p >= Math.Max(0,b.Length-65557); p--) {
        if (U32(b,p) == 0x06054b50 && p+22+U16(b,p+20) == b.Length) { end=p; break; }
      }
      Need(end >= 0 && U16(b,end+4) == 0 && U16(b,end+6) == 0, "ZIP_EOCD");
      ulong count = U16(b,end+10), diskCount = U16(b,end+8);
      ulong size = U32(b,end+12), offset = U32(b,end+16);
      long directoryEnd = end;
      bool locator = end >= 20 && U32(b,end-20) == 0x07064b50;
      if (locator) {
        Need(U32(b,end-16) == 0 && U32(b,end-4) == 1, "ZIP_MULTIDISK");
        ulong record = U64(b,end-12);
        Need(record <= (ulong)(end-20), "ZIP64_BOUNDS");
        long p = (long)record;
        Need(U32(b,p) == 0x06064b50 && U64(b,p+4) >= 44 && U64(b,p+4) <= 1024 &&
          p+12+(long)U64(b,p+4) == end-20, "ZIP64_EOCD");
        Need(U32(b,p+16) == 0 && U32(b,p+20) == 0, "ZIP_MULTIDISK");
        diskCount=U64(b,p+24); count=U64(b,p+32); size=U64(b,p+40); offset=U64(b,p+48);
        directoryEnd=p;
      } else {
        Need(count != 0xffff && size != 0xffffffff && offset != 0xffffffff, "ZIP64_LOCATOR");
      }
      Need(count == 22 && diskCount == count && offset <= (ulong)b.Length &&
        size <= (ulong)b.Length && offset+size == (ulong)directoryEnd, "ZIP_CENTRAL_COUNT");
      long cursor=(long)offset;
      var result=new Dictionary<string,Central>(StringComparer.Ordinal);
      var insensitive=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      var offsets=new HashSet<ulong>();
      for (int n=0; n<22; n++) {
        long p=cursor; Need(U32(b,p) == 0x02014b50, "ZIP_CENTRAL_HEADER");
        ushort made=U16(b,p+4), flags=U16(b,p+8), method=U16(b,p+10);
        Need((flags & ~0x080e) == 0 && (method == 0 || method == 8), "ZIP_FLAGS_METHOD");
        int nameLength=U16(b,p+28), extraLength=U16(b,p+30), commentLength=U16(b,p+32);
        int extra=(int)p+46+nameLength;
        Bounds(b,p,46L+nameLength+extraLength+commentLength);
        string name=Name(b,(int)p+46,nameLength);
        Need(insensitive.Add(name), "ZIP_DUPLICATE");
        uint attributes=U32(b,p+38);
        Need((made >> 8) == 3 && ((attributes >> 16) & 0xf000) == 0x8000 &&
          (attributes & (0x10u | 0x400u)) == 0, "ZIP_NON_REGULAR");
        ulong unpacked=U32(b,p+24), packed=U32(b,p+20), local=U32(b,p+42);
        uint disk=U16(b,p+34);
        bool need64=unpacked==0xffffffff || packed==0xffffffff || local==0xffffffff || disk==0xffff;
        bool got64=false;
        for (int x=extra; x<extra+extraLength;) {
          Bounds(b,x,4); int tag=U16(b,x), len=U16(b,x+2), data=x+4;
          Need(data+len <= extra+extraLength, "ZIP_EXTRA_BOUNDS");
          if (tag==1) {
            Need(!got64, "ZIP64_DUPLICATE"); got64=true; int q=data;
            if (unpacked==0xffffffff) { Need(q+8<=data+len,"ZIP64_FIELD"); unpacked=U64(b,q); q+=8; }
            if (packed==0xffffffff) { Need(q+8<=data+len,"ZIP64_FIELD"); packed=U64(b,q); q+=8; }
            if (local==0xffffffff) { Need(q+8<=data+len,"ZIP64_FIELD"); local=U64(b,q); q+=8; }
            if (disk==0xffff) { Need(q+4<=data+len,"ZIP64_FIELD"); disk=U32(b,q); }
          }
          x=data+len;
        }
        Need(!need64 || got64, "ZIP64_FIELD");
        Need(disk==0 && unpacked>0 && unpacked<=2*1024*1024 && packed<=(ulong)b.Length &&
          local<(ulong)offset && offsets.Add(local), "ZIP_ENTRY_LIMIT");
        long lp=(long)local;
        Need(U32(b,lp)==0x04034b50 && U16(b,lp+6)==flags && U16(b,lp+8)==method, "ZIP_LOCAL_HEADER");
        int ln=U16(b,lp+26), le=U16(b,lp+28);
        Need(Name(b,(int)lp+30,ln)==name, "ZIP_LOCAL_NAME");
        ulong dataStart=local+30+(ulong)ln+(ulong)le;
        Need(dataStart<=(ulong)offset && packed<=(ulong)offset-dataStart, "ZIP_LOCAL_DATA");
        result.Add(name,new Central {Name=name,Crc=U32(b,p+16),Size=unpacked,Packed=packed,
          Offset=local,Flags=flags,Method=method});
        cursor=p+46+nameLength+extraLength+commentLength;
      }
      Need(cursor == directoryEnd, "ZIP_CENTRAL_TRAILING");
      return result;
    }
    private static uint Crc(byte[] bytes) {
      uint crc=0xffffffff;
      foreach (byte value in bytes) {
        crc^=value;
        for (int i=0;i<8;i++) crc=(crc & 1)!=0 ? (crc>>1)^0xedb88320 : crc>>1;
      }
      return ~crc;
    }
    public static ArchivePlan Verify(byte[] archive) {
      Need(archive!=null && archive.Length==ArchiveBytes,"SOURCE_ZIP_SIZE");
      Need(Sha(archive)==ArchiveSha,"SOURCE_ZIP_SHA");
      var central=CentralDirectory(archive);
      var expected=new HashSet<string>(SourceNames,StringComparer.Ordinal);
      expected.Add("source-binding.json");
      Need(central.Count==22 && expected.SetEquals(central.Keys),"ZIP_WHITELIST");
      var payloads=new Dictionary<string,byte[]>(StringComparer.Ordinal);
      long aggregate=0;
      using (var memory=new MemoryStream(archive,false))
      using (var zip=new ZipArchive(memory,ZipArchiveMode.Read,false)) {
        Need(zip.Entries.Count==22,"ZIP_RUNTIME_COUNT");
        foreach (var entry in zip.Entries) {
          Central item;
          Need(central.TryGetValue(entry.FullName,out item) && !payloads.ContainsKey(entry.FullName),"ZIP_RUNTIME_NAME");
          Need(entry.Length==(long)item.Size && entry.CompressedLength==(long)item.Packed,"ZIP_RUNTIME_SIZE");
          aggregate+=entry.Length; Need(aggregate<=4*1024*1024,"ZIP_AGGREGATE");
          byte[] bytes=new byte[(int)entry.Length];
          using (var stream=entry.Open()) {
            int total=0,read;
            while (total<bytes.Length && (read=stream.Read(bytes,total,bytes.Length-total))>0) total+=read;
            Need(total==bytes.Length && stream.ReadByte()==-1,"ZIP_STREAM_SIZE");
          }
          Need(Crc(bytes)==item.Crc,"ZIP_CRC");
          payloads.Add(entry.FullName,bytes);
        }
      }
      Need(payloads["source-binding.json"].Length<=65536 && Sha(payloads["source-binding.json"])==ManifestSha,"SOURCE_MANIFEST_SHA");
      using (var json=JsonDocument.Parse(payloads["source-binding.json"])) {
        var root=json.RootElement;
        Need(root.GetProperty("schema").GetString()=="gongde-windows-source-freeze.v1" &&
          root.GetProperty("version").GetString()=="0.8.4","SOURCE_MANIFEST_SCHEMA");
        var files=root.GetProperty("files");
        Need(files.ValueKind==JsonValueKind.Array && files.GetArrayLength()==21,"SOURCE_MANIFEST_COUNT");
        var declared=new HashSet<string>(StringComparer.Ordinal);
        foreach (var file in files.EnumerateArray()) {
          string name=file.GetProperty("path").GetString(); SafeName(name);
          Need(declared.Add(name) && SourceNames.Contains(name,StringComparer.Ordinal),"SOURCE_MANIFEST_PATH");
          byte[] bytes=payloads[name];
          Need(file.GetProperty("bytes").GetInt64()==bytes.LongLength &&
            file.GetProperty("sha256").GetString()==Sha(bytes),"SOURCE_FILE_BINDING");
        }
        Need(declared.SetEquals(SourceNames),"SOURCE_MANIFEST_WHITELIST");
      }
      var plan=new ArchivePlan {Entries=new List<VerifiedEntry>()};
      foreach (string name in expected.OrderBy(x=>x,StringComparer.Ordinal))
        plan.Entries.Add(new VerifiedEntry {Path=name,Bytes=payloads[name]});
      return plan;
    }
  }
  public sealed class DirectoryLease : IDisposable {
    [StructLayout(LayoutKind.Sequential)] private struct AttributeTag { public uint Attributes,Tag; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern bool CreateDirectory(string path,IntPtr attributes);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,int kind,out AttributeTag info,uint size);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle file,StringBuilder path,uint size,uint flags);
    private readonly List<SafeFileHandle> handles=new List<SafeFileHandle>();
    private readonly HashSet<string> directories=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    public string Root { get; private set; }
    private static void Need(bool ok,string code) { if(!ok) throw new ReceiverFault(code); }
    public static void NoReparsePath(string path) {
      string current=System.IO.Path.GetFullPath(path);
      while (!String.IsNullOrEmpty(current)) {
        try { Need((File.GetAttributes(current)&FileAttributes.ReparsePoint)==0,"PATH_REPARSE"); }
        catch (FileNotFoundException) {} catch (DirectoryNotFoundException) {}
        string parent=System.IO.Path.GetDirectoryName(current);
        if(parent==current)break; current=parent;
      }
    }
    private static string Final(SafeFileHandle handle) {
      var value=new StringBuilder(32768);
      uint length=GetFinalPathNameByHandle(handle,value,(uint)value.Capacity,0);
      Need(length>0 && length<value.Capacity,"HANDLE_FINAL_PATH");
      string path=value.ToString();
      Need(path.StartsWith(@"\\?\") && !path.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase),"HANDLE_LOCAL_PATH");
      return path.Substring(4).TrimEnd('\\');
    }
    private void PinDirectory(string path) {
      NoReparsePath(path);
      var handle=CreateFile(path,0x80,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
      if(handle.IsInvalid) { handle.Dispose(); throw new ReceiverFault("DIRECTORY_PIN_FAILED"); }
      handles.Add(handle);
      AttributeTag info;
      Need(GetFileInformationByHandleEx(handle,9,out info,8) && (info.Attributes&0x10)!=0 &&
        (info.Attributes&0x400)==0 && String.Equals(Final(handle),path.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase),"DIRECTORY_IDENTITY");
    }
    public static DirectoryLease CreateExclusive(string root) {
      root=System.IO.Path.GetFullPath(root).TrimEnd('\\');
      var lease=new DirectoryLease {Root=root};
      try {
        string parent=System.IO.Path.GetDirectoryName(root);
        Need(Directory.Exists(parent),"ROOT_PARENT_MISSING");
        lease.PinDirectory(parent);
        Need(CreateDirectory(root,IntPtr.Zero),"ROOT_EXISTS_OR_CREATE_FAILED");
        lease.PinDirectory(root); lease.directories.Add(root);
        return lease;
      } catch { lease.Dispose(); throw; }
    }
    public void WriteNew(string relative,byte[] bytes) {
      ArchiveVerifier.SafeName(relative);
      string full=System.IO.Path.GetFullPath(System.IO.Path.Combine(Root,relative.Replace('/', '\\')));
      Need(full.StartsWith(Root+"\\",StringComparison.OrdinalIgnoreCase),"EXTRACT_ESCAPE");
      string parent=System.IO.Path.GetDirectoryName(full);
      string suffix=parent.Substring(Root.Length).TrimStart('\\');
      string current=Root;
      if(suffix.Length>0) foreach(string part in suffix.Split('\\')) {
        current=System.IO.Path.Combine(current,part);
        if(!directories.Contains(current)) {
          NoReparsePath(current);
          Need(CreateDirectory(current,IntPtr.Zero),"EXTRACT_DIRECTORY_EXISTS");
          PinDirectory(current); directories.Add(current);
        }
      }
      NoReparsePath(full);
      var handle=CreateFile(full,0x40000080,0,IntPtr.Zero,1,0x00200080,IntPtr.Zero);
      if(handle.IsInvalid) { handle.Dispose(); throw new ReceiverFault("EXTRACT_FILE_EXISTS_OR_CREATE_FAILED"); }
      using(handle) {
        AttributeTag info;
        Need(GetFileInformationByHandleEx(handle,9,out info,8) && (info.Attributes&(0x10u|0x400u))==0 &&
          String.Equals(Final(handle),full,StringComparison.OrdinalIgnoreCase),"EXTRACT_FILE_IDENTITY");
        using(var stream=new FileStream(handle,FileAccess.Write,8192,false)) { stream.Write(bytes,0,bytes.Length); stream.Flush(true); }
      }
    }
    public void Dispose() {
      for(int n=handles.Count-1;n>=0;n--)handles[n].Dispose();
      handles.Clear();
    }
  }
}
