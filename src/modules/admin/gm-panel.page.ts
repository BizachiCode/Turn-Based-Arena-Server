// GM panel page (`GET /gm`): one self-contained HTML document (no external requests) assembled from the parts under
// ./gm-panel: stylesheet, HTML shell and the client script (helpers, then one part per group of views, then boot).

import { renderGmShell } from "./gm-panel/markup.js";
import { SCRIPT_BOOT } from "./gm-panel/script-boot.js";
import { SCRIPT_COMMUNITY } from "./gm-panel/script-community.js";
import { SCRIPT_CORE } from "./gm-panel/script-core.js";
import { SCRIPT_LOGS } from "./gm-panel/script-logs.js";
import { SCRIPT_OPS } from "./gm-panel/script-ops.js";
import { SCRIPT_PLAYERS } from "./gm-panel/script-players.js";
import { SCRIPT_REPORTS } from "./gm-panel/script-reports.js";
import { GM_STYLES } from "./gm-panel/styles.js";

/** Client script order matters: views register themselves in `VIEWS` / `A` before the boot part routes. */
const CLIENT_SCRIPT = [SCRIPT_CORE, SCRIPT_OPS, SCRIPT_PLAYERS, SCRIPT_COMMUNITY, SCRIPT_REPORTS, SCRIPT_LOGS, SCRIPT_BOOT].join("\n");

/**
 * Content-Security-Policy of the panel page: scripts only with the per-response nonce (no inline handlers, no remote
 * code), requests only to the same origin, no framing, no forms, no plugins. Styles stay inline (the panel sets style
 * attributes), which cannot run code.
 */
export function gmPanelCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** `nonce`: the value of the response CSP; without it (tests) the script tag carries no attribute. */
export function renderGmPanelPage(nonce?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Turn-Based Arena GM Console</title>
  <style>${GM_STYLES}</style>
</head>
<body>
${renderGmShell()}
<script${nonce ? ` nonce="${nonce}"` : ""}>
(function () {
"use strict";
${CLIENT_SCRIPT}
})();
</script>
</body>
</html>`;
}
