// Colors and shared styles (port of styles.go).

import { Style, roundedBorder } from "./style.ts";

export const colorDeep = "#3c5e20";
export const colorSoft = "#6b7062";
export const colorLabel = "#a8c17a"; // bright enough for dark terminals
export const colorLine = "#c9c4b4";
export const colorAmber = "#a86a1f";

export const titleStyle = new Style()
  .foreground("#ffffff")
  .background(colorDeep)
  .bold(true)
  .padding(0, 2);

export const hintStyle = new Style().foreground(colorSoft);
export const labelStyle = new Style().foreground(colorLabel).bold(true);
export const mutedStyle = new Style().foreground(colorSoft);

export const popupStyle = new Style()
  .border(roundedBorder, true, true, true, true, colorDeep)
  .paddingLeft(1);

export const popupSelStyle = new Style()
  .foreground("#ffffff")
  .background(colorDeep);

export const popupAliasStyle = new Style().foreground(colorSoft);

export const badgeOn = new Style().foreground("#8fce5a").bold(true);
export const badgeOff = new Style().foreground(colorAmber).bold(true);

export const errStyle = new Style().foreground("#d98a4a").bold(true);

export const rightPanelWidth = 28;
export const maxSessions = 3;
export const popupMaxRows = 8;
