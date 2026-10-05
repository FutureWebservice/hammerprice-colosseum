/**
 * Photos for the listing draft: drawn again on a canvas (which drops every piece of metadata, GPS and camera data included), at most 1,280
 * pixels on the long edge, as JPEG under 600 KB. `fitSize` is pure; `shrinkImage` needs a browser.
 */
export const MAX_EDGE = 1280;
export const MAX_BYTES = 600 * 1024;

export function fitSize(w: number, h: number, max = MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** The base64 of a blob, without the data-URL prefix. */
const toBase64 = (blob: Blob): Promise<string> => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] ?? '');
  r.onerror = () => rej(new Error('read'));
  r.readAsDataURL(blob);
});

export interface Shrunk { mediaType: 'image/jpeg'; dataBase64: string; previewUrl: string }

/** Throws when the file is not a decodable JPEG, PNG or WebP image. */
export async function shrinkImage(file: File): Promise<Shrunk> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('type');
  const bmp = await createImageBitmap(file);
  const { width, height } = fitSize(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= MAX_BYTES) return { mediaType: 'image/jpeg', dataBase64: await toBase64(blob), previewUrl: URL.createObjectURL(blob) };
  }
  throw new Error('size');
}
