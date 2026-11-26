import {
  getTableViews,
  type TableDocument,
  type TableField,
} from "../../../packages/shared/src/table";
import type {
  DatabaseAdapter,
  PreparedStatementAdapter,
} from "./storage-contract";
import { sqlLiteral } from "./table-query-sql";

export { sqlLiteral } from "./table-query-sql";
export const jsonCell = (column: string, id: string) =>
  `json_extract(${column},${sqlLiteral("$." + JSON.stringify(id))})`;
export type SharedFieldIndex = {
  name: string;
  fieldId: string;
  direction: "asc" | "desc";
  type: string;
  options?: string[];
  expression: string;
};
export function sortExpression(
  field: TableField,
  direction: "asc" | "desc",
  column = "cells_json",
) {
  const cell = jsonCell(column, field.id);
  if (field.type === "select") {
    const options = field.options ?? [];
    return options.length
      ? `CASE ${cell} ${options.map((o, i) => `WHEN ${sqlLiteral(o)} THEN ${direction === "asc" ? i : options.length - 1 - i}`).join(" ")} ELSE ${options.length} END`
      : `${options.length}`;
  }
  return ["text", "url", "date"].includes(field.type)
    ? `NULLIF(${cell},'') COLLATE BINARY`
    : cell;
}
export function indexStatements(
  db: DatabaseAdapter,
  workspace: string,
  table: string,
  header: TableDocument,
  old: SharedFieldIndex[],
) {
  const next: SharedFieldIndex[] = [],
    statements: PreparedStatementAdapter[] = [];
  for (const view of getTableViews(header)) {
    const sort = view.sorts[0];
    if (!sort || sort.legacy) continue;
    const field = header.fields.find((f) => f.id === sort.fieldId);
    if (!field || field.type === "attachment") continue;
    const expression = sortExpression(field, sort.direction);
    if (
      next.some(
        (i) => i.expression === expression && i.direction === sort.direction,
      )
    )
      continue;
    const previous = old.find(
      (i) => i.expression === expression && i.direction === sort.direction,
    );
    const index = previous ?? {
      name: "ee_table_view_" + crypto.randomUUID().replaceAll("-", ""),
      fieldId: field.id,
      type: field.type,
      direction: sort.direction,
      options: field.options,
      expression,
    };
    next.push(index);
    if (!previous)
      statements.push(
        db.prepare(
          `CREATE INDEX ${index.name} ON ee_table_records(${expression} ${field.type === "select" ? "ASC" : sort.direction},position ASC) WHERE workspace_id=${sqlLiteral(workspace)} AND table_id=${sqlLiteral(table)}`,
        ),
      );
  }
  for (const index of old)
    if (!next.some((i) => i.name === index.name))
      statements.push(db.prepare(`DROP INDEX ${index.name}`));
  return { next, statements };
}
