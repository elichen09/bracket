/**
 * The tools' colour scheme: where it is kept, and the line that puts it on
 * the page before first paint. Plain constants, so the server-rendered tools
 * layout and the client-side Colours button can both read them.
 */
export const THEME_KEY = "tools.theme";
/** The tools' shape: square edges (the default) or cozy, rounded ones. */
export const SHAPE_KEY = "tools.shape";
export const THEME_BOOT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t&&t!=='forest')document.documentElement.setAttribute('data-tool-theme',t);if(localStorage.getItem('${SHAPE_KEY}')==='cozy')document.documentElement.setAttribute('data-tool-shape','cozy')}catch(e){}`;
