import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakable, identifier, quantity, year } from '../server/voice/speech.js';

const say = (t) => speakable(t, { callSign: 'KMXV' });

test('identifier style for station numbers, roads and rooms', () => {
  assert.equal(identifier(101), 'one oh one');
  assert.equal(identifier(138), 'one thirty-eight');
  assert.equal(identifier(100), 'one hundred');
  assert.equal(identifier(290), 'two ninety');
  assert.equal(identifier(1825), 'eighteen twenty-five');
  assert.equal(identifier(1080), 'ten eighty');
  assert.equal(identifier(1905), 'nineteen oh five');
});

test('quantities and years stay natural', () => {
  assert.equal(quantity(105), 'a hundred and five');
  assert.equal(quantity(300), 'three hundred');
  assert.equal(year(2026), 'twenty twenty-six');
  assert.equal(year(2005), 'two thousand five');
  assert.equal(year(1999), 'nineteen ninety-nine');
});

test('frequencies and station brands read the radio way', () => {
  assert.equal(say('Mix 101.9 FM'), 'Mix one oh one point nine F M');
  assert.equal(say('98.7'), 'ninety-eight point seven');
  assert.equal(say('Z100 and Q102'), 'Z one hundred and Q one oh two');
  assert.equal(say('Power 106'), 'Power one oh six');
  assert.equal(say('1080 AM'), 'ten eighty A M');
  assert.equal(say('This is KMXV.'), 'This is K M X V.');
});

test('roads, times, phones, symbols', () => {
  assert.equal(say('US 183 at I-35'), 'U S one eighty-three at I thirty-five');
  assert.equal(say('Highway 138'), 'Highway one thirty-eight');
  assert.equal(say('FM 1825'), 'F M eighteen twenty-five');
  assert.equal(say('7:05 pm'), 'seven oh five P M');
  assert.equal(say('7:00'), "seven o'clock");
  assert.equal(say('Call (512) 555-0199'), 'Call five one two, five five five, zero one nine nine');
  assert.equal(say('72° and 40%'), '72 degrees and 40 percent');
  assert.equal(say('It is 105 degrees'), 'It is a hundred and five degrees');
  assert.equal(say('visit mix1019.com'), 'visit mix one oh one nine dot com');
});

test('leaves ordinary text and audio tags alone', () => {
  assert.equal(say('[laughs] Okay so that was great.'), '[laughs] Okay so that was great.');
  assert.equal(say('June 15th, 3 shows'), 'June 15th, 3 shows');
});
