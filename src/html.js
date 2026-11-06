'use strict';
// Builds the webview HTML with a strict Content-Security-Policy: no remote content, scripts only by nonce.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

function nonce() { return crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, ''); }

// showSupportLinks: false hides the small Sponsor and More free viewers footer (setting hdf5NetcdfExplorer.showSupportLinks).
function buildHtml({ cspSource, scriptUri, styleUri, nonce: n = nonce(), showSupportLinks = true }) {
  const footer = footerHtml('hdf5NetcdfExplorer', showSupportLinks !== false, 'zovo-support-fixed');
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    footer ? `style-src ${cspSource} 'nonce-${n}'` : `style-src ${cspSource}`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${n}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${styleUri}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
<title>HDF5 NetCDF Explorer</title></head>
<body><div id="app"><p class="muted">Opening…</p></div>
${footer}
<script nonce="${n}" src="${scriptUri}"></script></body></html>`;
}

module.exports = { buildHtml, nonce };
