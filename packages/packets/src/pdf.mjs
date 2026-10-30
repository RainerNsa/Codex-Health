// A small PDF writer: one Courier text page per reference page, with what a fax or a scanner does to it. Everything is
// standard library, so a packet needs no renderer to reproduce it from its inputs.
// shortcut: degradation is vector (rotation, skew, grey ink, speckle), not a raster scan; a bitmap pipeline when the eval shows it matters.
const escape = (s) => s.replace(/[\\()]/g, '\\$&');

/** Bytes of a PDF. degrade: { rotate: 0 | 90 | 180 | 270, skewDegrees, gray: 0..1, speckle: count }; random: () => 0..1. */
export function renderPdf(pages, degrade, random) {
  const { rotate, skewDegrees, gray, speckle } = degrade;
  const radians = (skewDegrees * Math.PI) / 180;
  const [c, s] = [Math.cos(radians).toFixed(5), Math.sin(radians).toFixed(5)];
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // the page tree, filled in once the page objects exist
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const kids = [];
  for (const text of pages) {
    const body = [
      'BT', '/F1 9 Tf', `${gray} g`, `${c} ${s} ${-s} ${c} 54 738 Tm`, '12 TL',
      ...text.split('\n').flatMap((line) => [`(${escape(line)}) Tj`, 'T*']),
      'ET', '0.35 g',
      ...Array.from({ length: speckle }, () => `${(random() * 612).toFixed(1)} ${(random() * 792).toFixed(1)} ${(0.4 + random() * 1.2).toFixed(1)} ${(0.4 + random() * 1.2).toFixed(1)} re f`),
    ].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate ${rotate} /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`;
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
