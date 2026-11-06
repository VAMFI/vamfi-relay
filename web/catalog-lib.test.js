import test from 'node:test';
import assert from 'node:assert/strict';
import { canAutoRefreshCatalog, catalogActivity, filterCatalogThreads, groupCatalogThreads, handoffIdentity, formatCatalogDate } from './catalog-lib.js';

test('only Relay-owned confirmed activity is presented as live', () => {
  assert.equal(catalogActivity({ ownership: 'external', activity: { state: 'active' } }).label, 'Live status unknown');
  assert.equal(catalogActivity({ ownership: 'external', activity: { state: 'idle' } }).state, 'unknown');
  assert.equal(catalogActivity({ ownership: 'relay', activity: { state: 'active', basis: 'relay-run' } }).label, 'Active in Relay');
  assert.equal(catalogActivity({ ownership: 'relay', activity: { state: 'idle', basis: 'relay-run' } }).label, 'No active Relay run');
  assert.equal(catalogActivity({ ownership: 'relay', activity: { state: 'idle', basis: 'provider-snapshot' } }).state, 'unknown');
  assert.equal(catalogActivity({}).state, 'unknown');
});

test('search, project and activity filters compose without promoting chats into goals', () => {
  const threads = [
    { id: 'one', projectKey: 'a', title: 'Fix search', preview: 'Inspect mobile query', ownership: 'relay', activity: { state: 'active', basis: 'relay-run' } },
    { id: 'two', projectKey: 'b', title: 'Why can’t you inspect?', preview: 'Personal question', ownership: 'external', activity: { state: 'idle' } },
    { id: 'three', projectKey: 'a', title: 'Deploy website', preview: 'Ready for review', ownership: 'relay', activity: { state: 'idle', basis: 'relay-run' } },
  ];
  assert.deepEqual(filterCatalogThreads(threads, { query: ' MOBILE ', projectKey: 'a', activity: 'active' }).map(t => t.id), ['one']);
  assert.deepEqual(filterCatalogThreads(threads, { activity: 'unknown' }).map(t => t.id), ['two']);
  assert.deepEqual(filterCatalogThreads(threads, { query: 'why' }).map(t => t.id), ['two']);
  assert.equal(threads[1].goalId, undefined);
});

test('project grouping preserves equal names with different paths and newest chat order', () => {
  const groups = groupCatalogThreads([
    { id: 'older', projectKey: '/a/web', projectName: 'web', updatedAt: '2026-11-01T12:00:00Z' },
    { id: 'other', projectKey: '/b/web', projectName: 'web', updatedAt: '2026-11-05T12:00:00Z' },
    { id: 'new', projectKey: '/a/web', projectName: 'web', updatedAt: '2026-11-06T12:00:00Z' },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].threads.map(t => t.id), ['new', 'older']);
  assert.equal(groups[1].key, '/b/web');
});

test('network retry keeps a request identity but changed content creates a new one', () => {
  let count = 0;
  const uuid = () => `request-${++count}`;
  const body = { threadId: 'a', contextHash: 'hash-a', request: 'Please review' };
  const first = handoffIdentity(null, body, uuid);
  assert.equal(handoffIdentity(first, { ...body }, uuid), first);
  assert.notEqual(handoffIdentity(first, { ...body, request: 'Please fix' }, uuid).requestId, first.requestId);
  assert.notEqual(handoffIdentity(first, { ...body, contextHash: 'hash-b' }, uuid).requestId, first.requestId);
  assert.notEqual(handoffIdentity(first, { ...body, threadId: 'b' }, uuid).requestId, first.requestId);
});

test('missing or invalid timestamps are never shown as recent activity', () => {
  assert.equal(formatCatalogDate(null), 'Not recorded');
  assert.equal(formatCatalogDate('invalid'), 'Not recorded');
  assert.notEqual(formatCatalogDate('2026-11-06T12:00:00Z'), 'Not recorded');
});

test('automatic refresh never discards a user-expanded history or reads sample data', () => {
  const live = { sample: false, active: true, visibilityState: 'visible', busy: false, olderHistoryLoaded: false };
  assert.equal(canAutoRefreshCatalog(live), true);
  assert.equal(canAutoRefreshCatalog({ ...live, olderHistoryLoaded: true }), false);
  assert.equal(canAutoRefreshCatalog({ ...live, sample: true }), false);
  assert.equal(canAutoRefreshCatalog({ ...live, active: false }), false);
  assert.equal(canAutoRefreshCatalog({ ...live, visibilityState: 'hidden' }), false);
  assert.equal(canAutoRefreshCatalog({ ...live, busy: true }), false);
});
