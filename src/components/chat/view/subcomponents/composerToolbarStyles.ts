/**
 * One geometry and tone for every plain icon button in the composer toolbar
 * (attach, mic, commands, shell, schedule, clear): 32px square, rounded-lg,
 * muted glyph that brightens on hover with a muted surface. Controls that
 * carry a state (effort tier, context gauge, permission dot) keep their own
 * colour on top of this base; nothing in the row gets a frame of its own.
 */
export const COMPOSER_ICON_BUTTON_CLASS =
  'h-8 w-8 shrink-0 rounded-lg p-0 text-muted-foreground shadow-none hover:bg-muted hover:text-foreground [&_svg]:size-4';
