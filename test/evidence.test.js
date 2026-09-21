'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {reviewStatus} = require('../src/core/evidence');
const registry = require('../src/data/impact-registry.v1.json');

test('bundled evidence review dates fail closed without a runtime source request', () => {
  assert.deepEqual(reviewStatus({impact: {nextReviewDue: '2026-10-15'}}, new Date('2026-09-15T00:00:00Z')),
    {overdue: [], isOverdue: false});
  assert.deepEqual(reviewStatus({impact: {nextReviewDue: '2026-09-14'}, fx: {}}, new Date('2026-09-15T00:00:00Z')),
    {overdue: ['impact', 'fx'], isOverdue: true});
});

test('every numeric factor and priced model resolves complete evidence metadata', () => {
  const required = ['sourceUrl', 'publisher', 'publicationDate', 'effectiveDate', 'geography',
    'unit', 'boundary', 'derivation', 'licence', 'reviewedAt', 'nextReviewDue'];
  const assertEvidence = (reference) => {
    assert.equal(typeof reference, 'string');
    const evidence = registry.evidence[reference];
    assert.ok(evidence, `missing evidence ${reference}`);
    for (const field of required) assert.ok(Object.hasOwn(evidence, field), `${reference}.${field}`);
    assert.match(evidence.sourceUrl, /^https:\/\//);
    assert.ok(evidence.publisher);
    assert.ok(evidence.unit);
    assert.ok(evidence.boundary);
    assert.ok(evidence.derivation);
    assert.ok(evidence.licence);
    assert.match(evidence.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(evidence.nextReviewDue, /^\d{4}-\d{2}-\d{2}$/);
    for (const dateField of ['publicationDate', 'effectiveDate']) {
      assert.ok(evidence[dateField] === null || /^\d{4}-\d{2}-\d{2}$/.test(evidence[dateField]));
    }
  };

  for (const factor of [registry.energy, registry.water, registry.carbon]) assertEvidence(factor.evidenceRef);
  for (const model of registry.models) {
    if (model.priceUsdPerMillion) assertEvidence(model.priceEvidenceRef);
    else assert.ok(model.unpricedReason, `${model.id}.unpricedReason`);
  }
});
