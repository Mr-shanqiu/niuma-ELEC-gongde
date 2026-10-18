const WORK_ID = /^creator\.[a-f0-9]{32}\.[a-z0-9][a-z0-9-]{0,31}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const utf8 = new TextEncoder();

function publicText(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be text`);
  const text = value.trim();
  if (!text || text.length > 80 || CONTROL.test(text)) {
    throw new TypeError(`${field} must be 1-80 public characters without control characters`);
  }
  return text;
}

function templateInput({ workId, titleZh, author }) {
  if (typeof workId !== 'string' || !WORK_ID.test(workId)) {
    throw new TypeError('Create the work first and use its real platform work ID');
  }
  return { workId, titleZh: publicText(titleZh, 'titleZh'), author: publicText(author, 'author') };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function write16(view, offset, value) { view.setUint16(offset, value, true); }
function write32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

function zipStore(files) {
  const entries = files.map(([name, bytes]) => {
    const nameBytes = utf8.encode(name);
    return { nameBytes, bytes, crc: crc32(bytes) };
  });
  const localBytes = entries.reduce((sum, entry) => sum + 30 + entry.nameBytes.length + entry.bytes.length, 0);
  const centralBytes = entries.reduce((sum, entry) => sum + 46 + entry.nameBytes.length, 0);
  const output = new Uint8Array(localBytes + centralBytes + 22);
  const view = new DataView(output.buffer);
  const centralOffset = localBytes;
  let offset = 0;
  const centralEntries = [];
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const entry of entries) {
    const localOffset = offset;
    write32(view, offset, 0x04034b50);
    write16(view, offset + 4, 20);
    write16(view, offset + 6, 0);
    write16(view, offset + 8, 0);
    write16(view, offset + 10, 0);
    write16(view, offset + 12, dosDate);
    write32(view, offset + 14, entry.crc);
    write32(view, offset + 18, entry.bytes.length);
    write32(view, offset + 22, entry.bytes.length);
    write16(view, offset + 26, entry.nameBytes.length);
    write16(view, offset + 28, 0);
    offset += 30;
    output.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
    output.set(entry.bytes, offset);
    offset += entry.bytes.length;
    centralEntries.push({ ...entry, localOffset });
  }

  for (const entry of centralEntries) {
    write32(view, offset, 0x02014b50);
    write16(view, offset + 4, 20);
    write16(view, offset + 6, 20);
    write16(view, offset + 8, 0);
    write16(view, offset + 10, 0);
    write16(view, offset + 12, 0);
    write16(view, offset + 14, dosDate);
    write32(view, offset + 16, entry.crc);
    write32(view, offset + 20, entry.bytes.length);
    write32(view, offset + 24, entry.bytes.length);
    write16(view, offset + 28, entry.nameBytes.length);
    write16(view, offset + 30, 0);
    write16(view, offset + 32, 0);
    write16(view, offset + 34, 0);
    write16(view, offset + 36, 0);
    write32(view, offset + 38, 0);
    write32(view, offset + 42, entry.localOffset);
    offset += 46;
    output.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
  }

  write32(view, offset, 0x06054b50);
  write16(view, offset + 4, 0);
  write16(view, offset + 6, 0);
  write16(view, offset + 8, entries.length);
  write16(view, offset + 10, entries.length);
  write32(view, offset + 12, centralBytes);
  write32(view, offset + 16, centralOffset);
  write16(view, offset + 20, 0);
  return output;
}

function samplePng() {
  if (typeof document === 'undefined') throw new Error('Template download requires a browser canvas');
  const canvas = document.createElement('canvas');
  canvas.width = 180;
  canvas.height = 140;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.shadowColor = 'rgba(43, 51, 44, 0.2)';
  context.shadowBlur = 7;
  context.shadowOffsetY = 4;
  context.fillStyle = '#e8a13b';
  context.beginPath();
  context.moveTo(90, 13);
  context.bezierCurveTo(112, 13, 127, 31, 127, 53);
  context.lineTo(127, 97);
  context.quadraticCurveTo(127, 120, 104, 120);
  context.lineTo(76, 120);
  context.quadraticCurveTo(53, 120, 53, 97);
  context.lineTo(53, 53);
  context.bezierCurveTo(53, 31, 68, 13, 90, 13);
  context.closePath();
  context.fill();
  context.restore();

  context.fillStyle = '#fff1cf';
  context.beginPath();
  context.arc(77, 63, 6, 0, Math.PI * 2);
  context.arc(103, 63, 6, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#344c3d';
  context.beginPath();
  context.arc(78, 64, 2.5, 0, Math.PI * 2);
  context.arc(102, 64, 2.5, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#9e482b';
  context.lineWidth = 4;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(81, 84);
  context.quadraticCurveTo(90, 93, 99, 84);
  context.stroke();
  context.fillStyle = '#d86b47';
  context.beginPath();
  context.ellipse(66, 78, 6, 3, -0.2, 0, Math.PI * 2);
  context.ellipse(114, 78, 6, 3, 0.2, 0, Math.PI * 2);
  context.fill();

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Could not encode the local PNG template'));
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, 'image/png');
  });
}

export function buildCreatorInstructions({ workId, titleZh, author }) {
  const input = templateInput({ workId, titleZh, author });
  return `请按牛马电子功德创作者制作指南，基于我提供的标准模板完成一个普通 .nmgpack 投稿源包。\n作品 ID（必须原样保留）：${input.workId}\n公开作品名：${input.titleZh}\n公开作者署名：${input.author}\n\n请优先保持 Schema 1 和模板现有的一图层、有限关键帧结构。只按需修改根目录 manifest.json 与 PNG；不得修改作品 ID、publisher="community"、review_id="pending"。ZIP 根目录只放 manifest.json 和 manifest 引用的 PNG。\n源包不得包含 license、数字签名、订单、价格、授权码、脚本、可执行文件、开发代码、隐藏文件或未声明素材。不要联网下载素材，不要替我上传、投稿或声称审核通过。最终请交付普通 ZIP 格式的单个 .nmgpack，并列出文件清单及我需要确认的素材授权事项。`;
}

export async function downloadCreatorTemplate({ workId, titleZh, author }) {
  const input = templateInput({ workId, titleZh, author });
  const manifest = {
    schema_version: 1,
    id: input.workId,
    version: '1.0.0',
    name_zh: input.titleZh,
    name_en: 'Creator Appearance',
    author: input.author,
    publisher: 'community',
    review_id: 'pending',
    canvas_width: 240,
    canvas_height: 250,
    preview: 'sample.png',
    plus_y: 174,
    layers: [{
      image: 'sample.png',
      frame: [0, 0, 180, 140],
      anchor: [0.5, 0.5],
      keyframes: [
        { t: 0, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 },
        { t: 0.5, x: 0, y: 3, rotation: 2, scale: 1, alpha: 1 },
        { t: 1, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }
      ]
    }]
  };
  const png = await samplePng();
  const archive = zipStore([
    ['manifest.json', utf8.encode(JSON.stringify(manifest, null, 2) + '\n')],
    ['sample.png', png]
  ]);
  const filename = `creator-${input.workId.split('.').at(-1)}-schema1-template.nmgpack`;
  const url = URL.createObjectURL(new Blob([archive], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { filename, bytes: archive.byteLength, manifest };
}
