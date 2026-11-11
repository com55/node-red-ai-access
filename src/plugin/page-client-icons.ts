/** One shared inline SVG set for dashboard change and review status icons. */
export function pageClientIconsScript(): string {
  return `
  // Original paths in the Lucide style; the move arrow has four arrowheads.
  var statusIconPaths = {
    added: '<path d="M12 5v14M5 12h14"/>',
    removed: '<path d="M5 12h14"/>',
    modified: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 15z"/>',
    conflict: '<path d="M12 4v10"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>',
    moved: '<path d="M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
    resolved: '<path d="m4 12 5 5L20 6"/>',
    'editor-merged': '<circle cx="12" cy="12" r="8" fill="currentColor" stroke="none"/>',
    'deploy-pending': '<path d="m3 20 9-17 9 17zM12 9v5"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>'
  };
  function statusIcon(kind, options) {
    options = options || {};
    var size = options.size || 14;
    return '<svg xmlns="http://www.w3.org/2000/svg" class="status-icon" data-icon="' + kind + '" viewBox="0 0 24 24" width="' + size + '" height="' + size + '"' +
      (options.x == null ? '' : ' x="' + options.x + '" y="' + options.y + '"') +
      ' aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"' +
      (options.color ? ' color="' + options.color + '"' : '') + '>' + statusIconPaths[kind] + '</svg>';
  }
`;
}
