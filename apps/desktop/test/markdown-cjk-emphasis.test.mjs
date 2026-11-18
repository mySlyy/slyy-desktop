import { register } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { unified } from "unified";
import remarkParse from "remark-parse";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { advanceMarkdownBlocks, emptyMarkdownBlockCache, markdownRemarkPlugins } = await import("../src/lib/markdown-blocks.ts");

const render = source => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: markdownRemarkPlugins, children: source }));

test("CJK emphasis preserves source offsets and streaming grammar at every prefix", () => {
  const phrase = '**\u201c\u91cd\u70b9\u5185\u5bb9\u201d**';
  const source = `\u{1f600}\u8fd9\u662f${phrase}\uff0c\u8bf7\u67e5\u770b\u3002\n\n\u540e\u7eed**\u91cd\u70b9\u3002**\u7ee7\u7eed\u3002`;
  assert.match(render(source), /<strong>\u201c\u91cd\u70b9\u5185\u5bb9\u201d<\/strong>/);
  assert.match(render(source), /<strong>\u91cd\u70b9\u3002<\/strong>/);
  const root = unified().use(remarkParse).use(markdownRemarkPlugins).parse(source);
  const strong = root.children[0].children.find(node => node.type === "strong");
  assert.equal(source.slice(strong.position.start.offset, strong.position.end.offset), phrase);
  let cache = emptyMarkdownBlockCache;
  for (let end = 1; end <= source.length; end++) {
    const prefix = source.slice(0, end);
    cache = advanceMarkdownBlocks(cache, prefix);
    assert.equal(cache.blocks.join(""), prefix);
    assert.equal(cache.blocks.map(render).filter(Boolean).join("\n"), render(prefix), JSON.stringify(prefix));
  }
});

test("code, escapes, link destinations and English emphasis keep their grammar", () => {
  for (const source of ['\u8fd9\u662f`**\u201c\u793a\u4f8b\u201d**`\u3002', '```text\n\u8fd9\u662f**\u201c\u793a\u4f8b\u201d**\u3002\n```', '\u8fd9\u662f\\*\\*\u201c\u793a\u4f8b\u201d\\*\\*\u3002', 'a**"example"**']) {
    assert.doesNotMatch(render(source), /<strong[ >]/);
  }
  const url = 'https://example.com/**“path”**';
  assert.ok(render(`[link](${url})`).includes(`href="${encodeURI(url)}"`));
  assert.match(render('**bold** and *italic*'), /<strong>bold<\/strong> and <em>italic<\/em>/);
});
