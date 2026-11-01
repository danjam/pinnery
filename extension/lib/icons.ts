// Icons: SVG path data copied from Material Design Icons (https://pictogrammers.com/library/mdi/),
// @mdi/js 7.4.47, Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0). Only the icons the
// extension's options page uses; the app has its own copy in src/public/js/icons.js.

export const paths = {
  'alert-outline': 'M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16',
  'alert-circle': 'M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z',
  'check-circle': 'M12 2C6.5 2 2 6.5 2 12S6.5 22 12 22 22 17.5 22 12 17.5 2 12 2M10 17L5 12L6.41 10.59L10 14.17L17.59 6.58L19 8L10 17Z',
};

// An inline <svg> for the named icon. Sized by CSS (.icon); decorative unless a label is given.
export type IconName = keyof typeof paths;

export function icon(name: IconName, { label }: { label?: string } = {}): SVGSVGElement {
  const d = paths[name];
  if (!d) throw new Error(`unknown icon: ${name}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
