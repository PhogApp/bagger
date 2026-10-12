import { describe, expect, it } from "vitest";
import { applyMergeFields } from "../shared/merge";
import { htmlToText, looksLikeHtml, textToHtml } from "../shared/richtext";
import { cleanEmailHtml, messageFor } from "../server/sequences/html";

describe("email formatting", () => {
  it("turns plain text into paragraphs and line breaks, escaping as it goes", () => {
    expect(textToHtml("Hi Jill,\n\nQuick one:\nA & B <ok>\n\n\nThanks")).toBe(
      "<p>Hi Jill,</p><p>Quick one:<br>A &amp; B &lt;ok&gt;</p><p>Thanks</p>",
    );
    expect(textToHtml("   ")).toBe("");
    expect(looksLikeHtml("Revenue < cost and 3 > 2")).toBe(false);
    expect(looksLikeHtml("<p>Hi</p>")).toBe(true);
  });

  it("keeps only safe formatting", () => {
    const dirty =
      '<p onclick="x()">Hi <strong>Jill</strong> <script>alert(1)</script>' +
      '<a href="javascript:alert(1)">bad</a> <a href="https://phog.ai" style="color:red">good</a></p>' +
      '<ul><li>One</li><li><em>Two</em></li></ul><img src="x"><h1>Big</h1>';
    const clean = cleanEmailHtml(dirty);
    expect(clean).not.toMatch(/onclick|script|javascript|style|img|h1/);
    expect(clean).toContain("<strong>Jill</strong>");
    expect(clean).toContain(
      '<a href="https://phog.ai" target="_blank" rel="noopener noreferrer">good</a>',
    );
    expect(clean).toContain("<ul><li>One</li><li><em>Two</em></li></ul>");
    expect(clean).toContain("Big");
    expect(cleanEmailHtml("<p></p>")).toBe("");
    expect(cleanEmailHtml("Plain\ntext")).toBe("<p>Plain<br>text</p>");
  });

  it("reads HTML back as plain text, for LinkedIn and the activity log", () => {
    const html =
      '<p>Hi <strong>Jill</strong>,</p><p>See <a href="https://phog.ai">our site</a> or ' +
      '<a href="mailto:p@phog.ai">p@phog.ai</a>.</p><ul><li>Fast</li><li>Cheap</li></ul>' +
      "<ol><li>Call</li><li>Demo</li></ol><p>A &amp; B<br>Thanks</p>";
    expect(htmlToText(html)).toBe(
      "Hi Jill,\n\nSee our site (https://phog.ai) or p@phog.ai.\n\n• Fast\n• Cheap\n\n1. Call\n2. Demo\n\nA & B\nThanks",
    );
    expect(htmlToText("No tags & stays as is")).toBe("No tags & stays as is");
    expect(messageFor("linkedin", "<p>Hi <b>there</b></p>")).toBe("Hi there");
    expect(messageFor("email", null)).toBeNull();
  });

  it("escapes merge values inside email HTML but not in plain text", () => {
    const person = {
      firstName: "Ann",
      lastName: "Lee",
      email: "a@x.example",
      company: "Smith & <Sons>",
    };
    expect(applyMergeFields("<p>{company}</p>", person, { html: true })).toBe(
      "<p>Smith &amp; &lt;Sons&gt;</p>",
    );
    expect(applyMergeFields("{company}", person)).toBe("Smith & <Sons>");
  });
});
