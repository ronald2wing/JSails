/**
 * Tests for dashboard charts: descriptor validation, the SVG helpers (donut,
 * area, line, bar) with escaped labels, and the chart cards the dashboard
 * renders from each chart's trusted SVG. A throwing chart renders an empty card
 * without failing the page.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdminDefinitionError,
  areaChartSvg,
  barChartSvg,
  defineChart,
  donutChartSvg,
  lineChartSvg,
} from '../src/index.js';
import { createAdminTestApp } from './fixtures.js';

describe('chart helpers', () => {
  it('donutChartSvg emits one arc per point and escapes labels', () => {
    const svg = donutChartSvg([
      { label: '<x>', value: 1 },
      { label: 'b', value: 2 },
    ]);

    assert.match(svg, /<svg/);
    assert.match(svg, /&lt;x&gt;/);
    assert.doesNotMatch(svg, /<x>/);
  });

  it('areaChartSvg emits a filled polygon', () => {
    const svg = areaChartSvg([
      { label: 'a', value: 1 },
      { label: 'b', value: 3 },
    ]);

    assert.match(svg, /<polygon/);
  });
});

describe('admin dashboard charts', () => {
  it('renders a line chart SVG with its series labels inside a chart card', async () => {
    const app = await createAdminTestApp({
      charts: [
        defineChart({
          name: 'signups',
          label: 'Signups',
          render: () =>
            lineChartSvg([
              { label: 'Mon', value: 3 },
              { label: 'Tue', value: 7 },
            ]),
        }),
      ],
    });

    const body = await (await app.request('/admin')).text();
    assert.match(body, /admin-chart-card/);
    assert.match(body, /Signups/);
    assert.match(body, /<svg class="admin-chart"/);
    assert.match(body, /<polyline/);
    assert.match(body, />Mon</);
    assert.match(body, />Tue</);

    await app.close();
  });

  it('renders a bar chart SVG with rect bars', async () => {
    const app = await createAdminTestApp({
      charts: [
        defineChart({
          name: 'sales',
          label: 'Sales',
          render: () =>
            barChartSvg([
              { label: 'Jan', value: 4 },
              { label: 'Feb', value: 9 },
            ]),
        }),
      ],
    });

    const body = await (await app.request('/admin')).text();
    assert.match(body, /<svg class="admin-chart"/);
    assert.match(body, /<rect/);
    assert.match(body, />Jan</);
    assert.match(body, />Feb</);

    await app.close();
  });

  it('escapes hostile series labels in the SVG helpers', () => {
    const svg = lineChartSvg([{ label: '<b>X</b>', value: 1 }]);
    assert.doesNotMatch(svg, /<b>/);
    assert.match(svg, /&lt;b&gt;X&lt;\/b&gt;/);
  });

  it('renders an empty card when a chart render throws, without failing the page', async () => {
    const app = await createAdminTestApp({
      charts: [
        defineChart({
          name: 'broken',
          label: 'Broken',
          render: () => {
            throw new Error('boom');
          },
        }),
        defineChart({
          name: 'ok',
          label: 'Fine',
          render: () => lineChartSvg([{ label: 'A', value: 1 }]),
        }),
      ],
    });

    const response = await app.request('/admin');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Fine/);
    assert.match(body, /<svg class="admin-chart"/);

    await app.close();
  });

  it('rejects an invalid chart spec and duplicate chart names', () => {
    assert.throws(
      () => defineChart({ name: ' ', label: 'x', render: () => '' }),
      AdminDefinitionError,
    );
    assert.throws(
      () => defineChart({ name: 'x', label: ' ', render: () => '' }),
      AdminDefinitionError,
    );
    assert.throws(
      () => defineChart({ name: 'x', label: 'x', render: undefined as never }),
      AdminDefinitionError,
    );

    const charts = [
      defineChart({ name: 'dup', label: 'A', render: () => '' }),
      defineChart({ name: 'dup', label: 'B', render: () => '' }),
    ];
    assert.throws(() => createAdminTestApp({ charts }), AdminDefinitionError);
  });
});
