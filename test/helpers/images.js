import sharp from 'sharp';

// Test images generated on the fly, so there are no fixture files.

const blank = ({ width = 64, height = 64, color = '#d6336c' } = {}) =>
  sharp({ create: { width, height, channels: 3, background: color } });

/**
 * A solid-colour PNG.
 * @param {{ width?: number, height?: number, color?: string }} [opts] defaults 64x64, '#d6336c'.
 *   Different colours/sizes give different bytes, hence different content hashes.
 * @returns {Promise<Buffer>}
 */
export const pngBuffer = (opts) => blank(opts).png().toBuffer();

/** Same as pngBuffer, as a JPEG. */
export const jpegBuffer = (opts) => blank(opts).jpeg().toBuffer();
