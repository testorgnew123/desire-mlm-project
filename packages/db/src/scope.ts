/** What the product currently allows to be CREATED, kept in one object so the
 *  services read a single answer and a test can flip it.
 *
 *  plotsOnly: developments are plotted land -- a BLOCK of plots priced per square
 *  yard. Towers, flats and square-foot unit types still exist in the schema and
 *  in existing data (the code that handles them is untouched), but nothing can be
 *  newly created in that shape while this is true. Set it to false to return to
 *  creating apartments. Mutable on purpose, for tests only: production code never
 *  assigns it. */
export const SCOPE: { plotsOnly: boolean } = { plotsOnly: true };
