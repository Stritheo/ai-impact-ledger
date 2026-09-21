'use strict';

function reviewStatus(registries, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const overdue = [];
  for (const [name, registry] of Object.entries(registries || {})) {
    if (typeof registry?.nextReviewDue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(registry.nextReviewDue)
        || registry.nextReviewDue < today) overdue.push(name);
  }
  return {overdue, isOverdue: overdue.length > 0};
}

module.exports = {reviewStatus};
