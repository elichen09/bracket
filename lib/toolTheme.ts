/**
 * The tools' colour scheme: where it is kept, and the line that puts it on
 * the page before first paint. Plain constants, so the server-rendered tools
 * layout and the client-side Colours button can both read them.
 */
export const THEME_KEY = "tools.theme";
export const THEME_BOOT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t&&t!=='forest')document.documentElement.setAttribute('data-tool-theme',t)}catch(e){}`;
