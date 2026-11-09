'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeTagList,
    extractGameTags,
    deriveMoodTags,
    deriveContentTags
} = require('../src/scripts/content_tags');

test('normalizeTagList splits on commas, CJK commas and whitespace', () => {
    assert.deepEqual(normalizeTagList('影之刃零,搞笑、温情 岁己'), ['影之刃零', '搞笑', '温情', '岁己']);
    assert.deepEqual(normalizeTagList('  a ,, ,b ;；c  '), ['a', 'b', 'c']);
    assert.deepEqual(normalizeTagList(''), []);
    assert.deepEqual(normalizeTagList(null), []);
});

test('extractGameTags reads 《》 titles and alias patterns', () => {
    assert.deepEqual(extractGameTags('《影之刃：零》新一天直播'), ['影之刃：零', '影之刃零', '影之刃']);
    assert.ok(extractGameTags('陪老头环度过周日').includes('艾尔登法环'));
    assert.deepEqual(extractGameTags('普通杂谈回'), []);
});

test('deriveMoodTags only fires on explicit transcript cues from the whitelist', () => {
    assert.deepEqual(deriveMoodTags('笑死我了这也太逗了'), ['搞笑']);
    assert.deepEqual(deriveMoodTags('今天很感动，泪目了'), ['温情']);
    assert.deepEqual(deriveMoodTags('随便聊聊日常'), []);
});

test('deriveContentTags combines game and mood tags without duplicates', () => {
    const tags = deriveContentTags({
        streamTitle: '《影之刃：零》',
        matchedKeywords: ['笑死'],
        text: '我从那过来的我上不去了，我要传送过去。哈哈哈'
    });
    assert.ok(tags.includes('影之刃零'));
    assert.ok(tags.includes('搞笑'));
    assert.equal(new Set(tags).size, tags.length);
});

test('deriveContentTags adds controlled topic nouns and canonicalizes ASR aliases', () => {
    const tags = deriveContentTags({
        streamTitle: '周一午台',
        matchedKeywords: [],
        text: '我说我是赛4i，四爱，割追追，bgs吃太好了'
    });
    assert.deepEqual(tags, ['4i', '四爱', '假追追', '饼干岁']);
});

test('manual queue normalizeTagList is re-exported for --tags-extra', () => {
    const { normalizeTagList: fromQueue } = require('../src/scripts/manual_clip_queue');
    assert.equal(fromQueue, normalizeTagList);
});
