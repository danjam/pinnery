import sharp from 'sharp';

export interface ImageOpts {
  width?: number;
  height?: number;
  color?: string;
}

// Test images generated on the fly, so there are no fixture files.

const blank = ({ width = 64, height = 64, color = '#d6336c' }: ImageOpts = {}) =>
  sharp({ create: { width, height, channels: 3, background: color } });

// A solid-colour PNG. opts default to 64x64, '#d6336c'.
// Different colours/sizes give different bytes, hence different content hashes.
export const pngBuffer = (opts?: ImageOpts): Promise<Buffer> => blank(opts).png().toBuffer();

// Same as pngBuffer, as a JPEG.
export const jpegBuffer = (opts?: ImageOpts): Promise<Buffer> => blank(opts).jpeg().toBuffer();

// Same as pngBuffer, as an AVIF.
export const avifBuffer = (opts?: ImageOpts): Promise<Buffer> => blank(opts).avif().toBuffer();
