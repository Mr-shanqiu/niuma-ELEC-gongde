// A static image of the player's phase-zero frame. Embedded PNGs keep each
// cover self-contained; geometry is the same 240x170 contract as the canvas.
import { decode } from './preview-png.mjs';
const num = value => { if (!Number.isFinite(value)) throw new Error('invalid_still_geometry'); return String(value); };
const list = values => values.map(num).join(' ');
function image(bytes, rect, crop) {
  const size = decode(bytes), [x,y,w,h] = rect;
  const view = crop || [0,0,size.width,size.height];
  return `<g transform="translate(${list([x,y+h])}) scale(1 -1)"><svg width="${num(w)}" height="${num(h)}" viewBox="${list(view)}" preserveAspectRatio="none" overflow="hidden"><image width="${size.width}" height="${size.height}" href="data:image/png;base64,${bytes.toString('base64')}"/></svg></g>`;
}
export function stillSVG(manifest, layers) {
  let drawing = '';
  if (manifest.renderer) {
    if (manifest.renderer !== 'native-woodfish-v2') throw new Error('unsupported_native_still');
    const s=manifest.macOS, mallet=layers['mallet.png'], size=decode(mallet);
    const factor=size.width / (manifest.sourceDimensions?.['mallet.png']?.width || size.width);
    const [x,y,w,h]=s.shadow;
    drawing=`<g transform="translate(${list(s.center)}) scale(${num(s.scale)}) translate(${list(s.center.map(v=>-v))})">`+
      `<ellipse cx="${num(x+w/2)}" cy="${num(y+h/2)}" rx="${num(w/2)}" ry="${num(h/2)}" fill="black" fill-opacity="0.25"/>`+
      image(layers['body.png'],s.body)+`<g transform="translate(${list(s.pivot)}) rotate(${num(s.angle[0])})">`+
      image(mallet,s.shaft,[s.shaftSourceX*factor,0,size.width-s.shaftSourceX*factor,size.height])+
      image(mallet,s.head,[0,0,Math.min(s.headSourceWidth*factor,size.width),size.height])+'</g></g>';
  } else for (const layer of manifest.layers) {
    const f=layer.keyframes[0], [x,y,w,h]=layer.frame, ax=x+w*layer.anchor[0],ay=y+h*layer.anchor[1];
    drawing+=`<g opacity="${num(f.alpha)}" transform="translate(${list([ax+f.x,ay+f.y])}) rotate(${num(f.rotation)}) scale(${list([f.scale,f.scale*(f.scale_y??1)])}) translate(${list([-ax,-ay])})">`+
      image(layers[layer.image],layer.frame)+'</g>';
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="340" viewBox="0 0 240 170"><g transform="translate(0 170) scale(1 -1)">${drawing}</g></svg>\n`);
}
