/**
 * Everything a tool needs to hand results to the user as files. The heavy
 * writers (xlsx, docx, zip) load their libraries when first called, so
 * importing this module costs almost nothing.
 */
export { toDocx } from './docx';
export { formatTimestamp, toSrt, toVtt, wrapLines } from './subtitles';
export type { SubtitleOptions, SubtitleSegment } from './subtitles';
export { cellText, toCsv, toJsonBlob, toMarkdownTable, toTsv } from './table';
export type { CsvOptions, DelimitedOptions, ExportColumn, ExportRow } from './table';
export { sanitizeSheetName, toXlsx } from './xlsx';
export type { XlsxColumn, XlsxSheet } from './xlsx';
export { zipFiles } from './zip';
export type { ZipEntry, ZipOptions } from './zip';
