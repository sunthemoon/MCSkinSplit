import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

const layoutDirectory = resolve(process.cwd(), "src/layouts");

describe("layout JSON schema", () => {
  it.each(["wide-64.json", "slim-64.json"])("validates %s", async (fileName) => {
    const [schemaText, layoutText] = await Promise.all([
      readFile(resolve(layoutDirectory, "schema.json"), "utf8"),
      readFile(resolve(layoutDirectory, fileName), "utf8"),
    ]);
    const validate = new Ajv({ allErrors: true, strict: true }).compile(
      JSON.parse(schemaText),
    );

    const valid = validate(JSON.parse(layoutText));
    expect(validate.errors).toEqual(null);
    expect(valid).toBe(true);
  });
});
