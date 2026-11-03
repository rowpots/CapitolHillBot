import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commandSignature,
  parseCommand,
  parseMention,
  parsePickToken,
  parseTradeCommand,
} from "../chat-commands.js";

describe("parseCommand", () => {
  it("parses name and args, case/whitespace-tolerant", () => {
    assert.deepEqual(parseCommand("!Standings  BOB"), {
      name: "standings",
      args: ["BOB"],
      argString: "BOB",
    });
  });

  it("rejects non-commands and a bare prefix", () => {
    assert.equal(parseCommand("hello"), null);
    assert.equal(parseCommand("!"), null);
    assert.equal(parseCommand("@capitolhillbot hi"), null);
  });
});

describe("commandSignature", () => {
  it("normalizes case and whitespace so retypes dedupe", () => {
    assert.equal(
      commandSignature({ from: "Jake", text: "!Trade  A for B" }),
      commandSignature({ from: " jake ", text: "!trade a for b" })
    );
  });
});

describe("parseMention", () => {
  const handles = ["capitolhillbot"];

  it("extracts the question after a tag", () => {
    assert.deepEqual(parseMention("@capitolhillbot who's the best team?", handles), {
      question: "who's the best team?",
    });
    assert.deepEqual(parseMention("@CapitolHillBot: roast jake", handles), { question: "roast jake" });
  });

  it("strips a tag from the middle of a message", () => {
    assert.deepEqual(parseMention("yo @capitolhillbot who wins tonight", handles), {
      question: "yo who wins tonight",
    });
  });

  it("returns an empty question for a bare tag", () => {
    assert.deepEqual(parseMention("@capitolhillbot", handles), { question: "" });
    assert.deepEqual(parseMention("  @capitolhillbot!  ", handles), { question: "" });
  });

  it("ignores near-misses, other tags, and untagged text", () => {
    assert.equal(parseMention("@capitolhillbots lol", handles), null);
    assert.equal(parseMention("@jake shut up", handles), null);
    assert.equal(parseMention("capitolhillbot who wins", handles), null);
    assert.equal(parseMention("!trade a for b", handles), null);
  });

  it("supports display-name handles with spaces", () => {
    assert.deepEqual(parseMention("@Capitol Hill Bot hi", ["Capitol Hill Bot"]), { question: "hi" });
  });
});

describe("parseTradeCommand", () => {
  it("splits sides on 'for' and items on commas/and", () => {
    assert.deepEqual(parseTradeCommand("Bijan, 2027 1st for Puka and Nabers"), {
      sideA: ["Bijan", "2027 1st"],
      sideB: ["Puka", "Nabers"],
    });
  });

  it("accepts the other separators", () => {
    assert.deepEqual(parseTradeCommand("A | B"), { sideA: ["A"], sideB: ["B"] });
    assert.deepEqual(parseTradeCommand("A vs B + C"), { sideA: ["A"], sideB: ["B", "C"] });
  });

  it("straightens curly quotes from phone keyboards", () => {
    assert.deepEqual(parseTradeCommand("Ja’Marr Chase for Puka"), {
      sideA: ["Ja'Marr Chase"],
      sideB: ["Puka"],
    });
  });

  it("rejects input without exactly two sides", () => {
    assert.equal(parseTradeCommand(""), null);
    assert.equal(parseTradeCommand("Bijan"), null);
    assert.equal(parseTradeCommand("A for B for C"), null);
  });
});

describe("parsePickToken", () => {
  const november = new Date("2026-11-03T12:00:00Z");
  const march = new Date("2026-03-01T12:00:00Z");

  it("reads year, round, and tier", () => {
    assert.deepEqual(parsePickToken("2027 1st", november), { season: 2027, round: 1, tier: null });
    assert.deepEqual(parsePickToken("'27 early 2nd", november), { season: 2027, round: 2, tier: "Early" });
    assert.deepEqual(parsePickToken("2028 round 1", november), { season: 2028, round: 1, tier: null });
    assert.deepEqual(parsePickToken("mid third", november), { season: 2027, round: 3, tier: "Mid" });
  });

  it("defaults a missing year to the next rookie draft (May cutover)", () => {
    assert.equal(parsePickToken("late first", november).season, 2027);
    assert.equal(parsePickToken("late first", march).season, 2026);
  });

  it("never swallows player names or bare digits", () => {
    assert.equal(parsePickToken("Jahmyr Gibbs", november), null);
    assert.equal(parsePickToken("2", november), null);
    assert.deepEqual(parsePickToken("round 2", november), { season: 2027, round: 2, tier: null });
  });
});
