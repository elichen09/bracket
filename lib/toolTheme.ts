/**
 * The tools' colour scheme: where it is kept, and the line that puts it on
 * the page before first paint. Plain constants, so the server-rendered tools
 * layout and the client-side Colours button can both read them.
 */
export const THEME_KEY = "tools.theme";
/** The tools' shape: square edges (the default) or cozy, rounded ones. */
export const SHAPE_KEY = "tools.shape";
/** Cozy's rounded face, fetched only by someone who has chosen Cozy. */
export const COZY_FONT = "https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800&display=swap";
export const THEME_BOOT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t&&t!=='forest')document.documentElement.setAttribute('data-tool-theme',t);if(localStorage.getItem('${SHAPE_KEY}')==='cozy'){document.documentElement.setAttribute('data-tool-shape','cozy');var l=document.createElement('link');l.rel='stylesheet';l.id='cozy-font';l.href='${COZY_FONT}';document.head.appendChild(l)}}catch(e){}`;
