// Image-only PDFs, as a fax or a scanner leaves them: each page is a bitmap with no text layer, so OCR has to read it. Text
// is drawn dot-matrix, then the sheet is tilted or turned, blurred, faded, speckled and given fax dropouts. Everything is
// standard library, so a packet needs no renderer to reproduce it from its inputs.
import { deflateSync } from 'node:zlib';
import { glyph } from './font.mjs';

const [WIDTH, HEIGHT] = [1700, 2200]; // Letter at 200 dpi, fax fine mode
const [SCALE, ADVANCE, LINE, MARGIN] = [3, 18, 30, 120];
const WHITE = 255;

function drawText(text) {
  const sheet = new Uint8Array(WIDTH * HEIGHT).fill(WHITE);
  text.split('\n').forEach((line, row) => [...line].forEach((char, col) => {
    glyph(char).forEach((bits, column) => {
      for (let bit = 0; bit < 7; bit += 1) {
        if (!(bits & (1 << bit))) continue;
        const [left, top] = [MARGIN + col * ADVANCE + column * SCALE, MARGIN + row * LINE + bit * SCALE];
        for (let y = top; y < top + SCALE; y += 1) sheet.fill(0, y * WIDTH + left, y * WIDTH + left + SCALE);
      }
    });
  }));
  return sheet;
}

/** The sheet as it went through the machine: nearest-neighbour turn and tilt about the centre, white where paper ran out. */
function turn(sheet, rotate, skewDegrees) {
  const [width, height] = rotate % 180 === 0 ? [WIDTH, HEIGHT] : [HEIGHT, WIDTH];
  const angle = ((rotate + skewDegrees) * Math.PI) / 180;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const out = new Uint8Array(width * height).fill(WHITE);
  for (let y = 0; y < height; y += 1) {
    const v = y - height / 2;
    for (let x = 0; x < width; x += 1) {
      const u = x - width / 2;
      const [sx, sy] = [Math.round(c * u + s * v + WIDTH / 2), Math.round(-s * u + c * v + HEIGHT / 2)];
      if (sx >= 0 && sx < WIDTH && sy >= 0 && sy < HEIGHT) out[y * width + x] = sheet[sy * WIDTH + sx];
    }
  }
  return { pixels: out, width, height };
}

function wear({ pixels, width, height }, { blur, fade, speckle, dropouts, fax }, random) {
  const soft = blur ? pixels.map((v, i) => (v * 4 + (pixels[i - 1] ?? WHITE) + (pixels[i + 1] ?? WHITE) + (pixels[i - width] ?? WHITE) + (pixels[i + width] ?? WHITE)) / 8) : pixels;
  const out = soft.map((v) => WHITE - (WHITE - v) * (1 - fade));
  for (let i = 0; i < speckle; i += 1) {
    const at = Math.floor(random() * height) * width + Math.floor(random() * width);
    out.fill(40, at, Math.min(at + 1 + Math.floor(random() * 3), out.length));
  }
  for (let i = 0; i < dropouts; i += 1) { // a fax line the machine lost
    const row = Math.floor(random() * height);
    out.fill(WHITE, row * width, (row + 1) * width);
  }
  return fax ? out.map((v) => (v < 170 ? 0 : WHITE)) : out;
}

/** Bytes of a PDF. degrade: { rotate: 0 | 90 | 180 | 270, skewDegrees, blur, fade: 0..1, speckle, dropouts, fax }; random: () => 0..1. */
export function renderPdf(pages, degrade, random) {
  const objects = [];
  const add = (body) => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // the page tree, filled in once the page objects exist
  const kids = pages.map((text) => {
    const { rotate, skewDegrees } = degrade;
    const image = turn(drawText(text), rotate, skewDegrees);
    const data = deflateSync(wear(image, degrade, random));
    const [points, across] = rotate % 180 === 0 ? [[612, 792], image.width] : [[792, 612], image.width];
    const xobject = add(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${across} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, 'latin1'),
      data, Buffer.from('\nendstream', 'latin1'),
    ]));
    const body = `q ${points[0]} 0 0 ${points[1]} 0 0 cm /Im0 Do Q`;
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${points[0]} ${points[1]}] /Resources << /XObject << /Im0 ${xobject} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`, 'latin1');
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let at = parts[0].length;
  const push = (b) => { parts.push(b); at += b.length; };
  const offsets = objects.map((body, i) => {
    const start = at;
    push(Buffer.from(`${i + 1} 0 obj\n`, 'latin1')); push(body); push(Buffer.from('\nendobj\n', 'latin1'));
    return start;
  });
  const xref = at;
  push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
