/**
 * Light or dark, and where the choice is kept.
 *
 * @dev In a plain module rather than next to the toggle, because the toggle
 *      lives in a client component and the root layout is a server one. A
 *      server component importing a constant out of a `'use client'` file gets
 *      a client reference rather than the string, so the key would silently
 *      stop matching.
 */
export const THEME_KEY = 'motif-theme'

/**
 * Applied in the document head, before the first paint.
 *
 * Without it a visitor who chose light would see the dark page paint first
 * and then flip once React loaded, on every page. Dark is the default and
 * what the server renders, so only an explicit light changes anything, and a
 * browser that refuses storage simply stays dark.
 */
export const THEME_BOOT =
  `try{if(localStorage.getItem('${THEME_KEY}')==='light')` +
  `document.documentElement.dataset.theme='light'}catch(e){}`
