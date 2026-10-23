#include "embedded_scene.h"
#include <bcrypt.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <cstring>

namespace niuma::windows::runtime {
namespace {
struct Resource { const BYTE* bytes=nullptr; DWORD size=0; };
bool Read(unsigned id,Resource& r) {
  auto resource=FindResourceW(nullptr,MAKEINTRESOURCEW(id),RT_RCDATA);
  if(!resource) return false;
  auto handle=LoadResource(nullptr,resource);
  r.size=SizeofResource(nullptr,resource);
  r.bytes=static_cast<const BYTE*>(LockResource(handle));
  return r.bytes && r.size && r.size<=24*1024*1024;
}
bool Decode(const Resource& r,niuma::runtime::PixelImage& image,std::size_t remaining) {
  using Microsoft::WRL::ComPtr;
  ComPtr<IWICImagingFactory> factory;
  ComPtr<IWICStream> stream;
  ComPtr<IWICBitmapDecoder> decoder;
  ComPtr<IWICBitmapFrameDecode> frame;
  ComPtr<IWICFormatConverter> converter;
  GUID format{}; UINT frames=0,width=0,height=0;
  if(FAILED(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&factory))) ||
      FAILED(factory->CreateStream(&stream)) ||
      FAILED(stream->InitializeFromMemory(const_cast<BYTE*>(r.bytes),r.size)) ||
      FAILED(factory->CreateDecoderFromStream(stream.Get(),nullptr,WICDecodeMetadataCacheOnLoad,&decoder)) ||
      FAILED(decoder->GetContainerFormat(&format)) || format!=GUID_ContainerFormatPng ||
      FAILED(decoder->GetFrameCount(&frames)) || frames!=1 || FAILED(decoder->GetFrame(0,&frame)) ||
      FAILED(frame->GetSize(&width,&height)) || !width || !height || width>2048 || height>2048 ||
      std::uint64_t(width)*height*4>remaining || FAILED(factory->CreateFormatConverter(&converter)) ||
      FAILED(converter->Initialize(frame.Get(),GUID_WICPixelFormat32bppPBGRA,WICBitmapDitherTypeNone,
          nullptr,0,WICBitmapPaletteTypeCustom))) return false;
  image.width=width; image.height=height; image.strideBytes=width*4;
  image.bgraPremultiplied.resize(static_cast<std::size_t>(width)*height*4);
  return SUCCEEDED(converter->CopyPixels(nullptr,image.strideBytes,
      static_cast<UINT>(image.bgraPremultiplied.size()),image.bgraPremultiplied.data()));
}
}
bool EmbeddedWoodfishRequest(niuma::AppearanceResourceRequest& request) {
  Resource body,mallet;
  if(!Read(101,body) || !Read(102,mallet)) return false;
  BCRYPT_ALG_HANDLE algorithm=nullptr; BCRYPT_HASH_HANDLE hash=nullptr;
  DWORD size=0,read=0;
  if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)!=0) return false;
  bool okay=BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&size),sizeof(size),&read,0)==0;
  std::vector<BYTE> object(okay?size:0);
  if(okay) okay=BCryptCreateHash(algorithm,&hash,object.data(),size,nullptr,0,0)==0;
  constexpr char version[]="niuma-embedded-woodfish-shadow-v1";
  BYTE digest[32]{};
  if(okay) okay=BCryptHashData(hash,reinterpret_cast<PUCHAR>(const_cast<char*>(version)),sizeof(version),0)==0 &&
      BCryptHashData(hash,const_cast<PUCHAR>(body.bytes),body.size,0)==0 &&
      BCryptHashData(hash,const_cast<PUCHAR>(mallet.bytes),mallet.size,0)==0 &&
      BCryptFinishHash(hash,digest,sizeof(digest),0)==0;
  if(hash) BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm,0);
  if(!okay) return false;
  std::string fingerprint; fingerprint.reserve(64);
  constexpr char hex[]="0123456789abcdef";
  for(auto value:digest) { fingerprint+=hex[value>>4]; fingerprint+=hex[value&15]; }
  request={L"","builtin.woodfish",fingerprint};
  return true;
}
AppearanceSceneStatus PrepareEmbeddedWoodfishScene(const niuma::AppearanceResourceRequest& expected,
    std::unique_ptr<PreparedAppearanceScene>* output,std::wstring* error) {
  if(output) output->reset();
  niuma::AppearanceResourceRequest actual;
  if(!output || !EmbeddedWoodfishRequest(actual) || actual.id!=expected.id ||
      actual.sourcePath!=expected.sourcePath || actual.contentFingerprint!=expected.contentFingerprint) {
    if(error) *error=L"内置木鱼资源身份不匹配。";
    return AppearanceSceneStatus::Changed;
  }
  Resource body,mallet;
  niuma::runtime::PixelImage bodyPixels,malletPixels;
  constexpr std::size_t limit=24*1024*1024;
  if(!Read(101,body) || !Read(102,mallet) || !Decode(body,bodyPixels,limit) ||
      !Decode(mallet,malletPixels,limit-bodyPixels.bgraPremultiplied.size())) {
    if(error) *error=L"内置木鱼资源无法完整准备。";
    return AppearanceSceneStatus::ImageUnavailable;
  }
  return PrepareWoodfishScene(std::move(bodyPixels),std::move(malletPixels),actual.contentFingerprint,
      {},output,error);
}
}
