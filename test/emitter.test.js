'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTarget, buildMessage } = require('../src/emitter');

test('parseTarget: telegram:id', () => {
  const r = parseTarget('telegram:8625301893');
  assert.equal(r.channel, 'telegram');
  assert.equal(r.target, '8625301893');
});

test('parseTarget: discord:channelid', () => {
  const r = parseTarget('discord:123456789');
  assert.equal(r.channel, 'discord');
  assert.equal(r.target, '123456789');
});

test('parseTarget: bare id defaults to telegram', () => {
  const r = parseTarget('8625301893');
  assert.equal(r.channel, 'telegram');
  assert.equal(r.target, '8625301893');
});

test('parseTarget: empty string throws', () => {
  assert.throws(() => parseTarget(''));
});

test('buildMessage: running', () => {
  const task = { title: 'My Task', checkin_every_minutes: 3, last_observed_at: '2026-03-13T00:00:00Z' };
  const msg = buildMessage(task, 'running');
  assert.ok(msg.includes('[Agent Follow-Up]'));
  assert.ok(msg.includes('My Task'));
  assert.ok(msg.includes('running'));
  assert.ok(msg.includes('3m'));
});

test('buildMessage: completed', () => {
  const task = { title: 'Done Task', checkin_every_minutes: 5 };
  const msg = buildMessage(task, 'completed');
  assert.ok(msg.includes('completed'));
  assert.ok(msg.includes('Done Task'));
});

test('buildMessage: failed', () => {
  const task = { title: 'Bad Task', checkin_every_minutes: 5 };
  const msg = buildMessage(task, 'failed');
  assert.ok(msg.includes('failed'));
});

test('buildMessage: unknown', () => {
  const task = { title: 'Mystery Task', checkin_every_minutes: 3 };
  const msg = buildMessage(task, 'unknown');
  assert.ok(msg.includes('unknown'));
  assert.ok(msg.includes('3m'));
});

test('buildMessage: stale', () => {
  const task = { title: 'Old Task', checkin_every_minutes: 3, last_observed_at: '2026-03-01T00:00:00Z' };
  const msg = buildMessage(task, 'stale');
  assert.ok(msg.includes('stale'));
  assert.ok(msg.includes('Old Task'));
});
