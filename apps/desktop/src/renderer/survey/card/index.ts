// The shared measurement card (volumetric parity W2): one card for every tool, live while
// drawing, in the detail panel and in the report. `MeasureCard` and `cardModel` read no store;
// `CardMenu` and `CardActions` are the controls the detail card is given.
export { CardActions, CardMenu, NOTES_MAX } from './CardActions';
export { cardModel, splitValue, TOOL_ICON, type CardContext, type CardModel } from './cardModel';
export { MeasureCard, NAME_MAX, type CardSlots, type CardVariant } from './MeasureCard';
