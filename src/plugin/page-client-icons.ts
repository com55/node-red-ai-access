/** One shared inline SVG set for dashboard change and review status icons. */
export function pageClientIconsScript(): string {
  return `
  // The move icon separates its four filled heads from a thin cross for 12px badges.
  var statusIconPaths = {
    added: '<path d="M12 5v14M5 12h14"/>',
    removed: '<path d="M5 12h14"/>',
    modified: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 15z"/>',
    conflict: '<path d="M12 4v10"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>',
    moved: '<path d="M12 6v12M6 12h12" stroke-width="2"/><g fill="currentColor" stroke="none"><path d="M12 1L8 6h8z"/><path d="M23 12L18 8v8z"/><path d="M12 23L8 18h8z"/><path d="M1 12L6 8v8z"/></g>',
    resolved: '<path d="m4 12 5 5L20 6"/>',
    'editor-merged': '<circle cx="12" cy="12" r="8" fill="currentColor" stroke="none"/>',
    'deploy-pending': '<path d="m3 20 9-17 9 17zM12 9v5"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>'
  };
  function statusIcon(kind, options) {
    options = options || {};
    var size = options.size || 14;
    kind = kind || '';
    var path = Object.prototype.hasOwnProperty.call(statusIconPaths, kind) ? statusIconPaths[kind] : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" class="status-icon" data-icon="' + kind + '" viewBox="0 0 24 24" width="' + size + '" height="' + size + '"' +
      (options.x == null ? '' : ' x="' + options.x + '" y="' + options.y + '"') +
      ' aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"' +
      (options.color ? ' color="' + options.color + '"' : '') + '>' + path + '</svg>';
  }
`;
}
