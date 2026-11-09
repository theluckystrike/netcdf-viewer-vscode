'use strict';
// Turns a compare report into the table description the report panel and the CSV/Markdown export use.
const { cellText } = require('./table');

const int = v => cellText(v, 'int');
const sec = ms => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function describeCompare(r) {
  const s = r.summary;
  const facts = [
    ['Identical', int(s.identical)], ['Changed', int(s.changed)], ['Shape differs', int(s.shapeDiffers)], ['Type differs', int(s.typeDiffers)],
    ['Attributes differ', int(s.attrsDiffer)], ['Only in A', int(s.onlyA)], ['Only in B', int(s.onlyB)], ['Not compared', int(s.notCompared)],
    ['Values compared', int(s.valuesCompared)], ['Time', sec(r.ms)],
  ];
  const notes = [];
  if (r.stopped) notes.push('Stopped before the end. The variables after that point are listed as "not compared".');
  if (s.truncated) notes.push('One file has more than 5,000 variables or a group with more than 5,000 members. Only the first ones were compared.');
  if (s.tolerance > 0) notes.push(`Values that differ by ${s.tolerance} or less count as equal (setting hdf5NetcdfExplorer.compareTolerance).`);
  const clean = !s.changed && !s.shapeDiffers && !s.typeDiffers && !s.attrsDiffer && !s.onlyA && !s.onlyB && !s.notCompared;
  if (clean) notes.push('Every variable and attribute is the same in both files.');
  const rows = r.rows.map(x => ({ ...x, _mark: x.status === 'changed' || x.status === 'shape differs' ? 'bad' : x.status === 'identical' ? '' : 'warn' }));
  return {
    title: `Compare: ${r.fileA} vs ${r.fileB}`,
    subtitle: `A = ${r.fileA} (${r.formatA}), B = ${r.fileB} (${r.formatB}). Every value of every numeric variable in both files was read and compared after CF decoding. Attribute names: "-" only in A, "+" only in B.`,
    facts, notes, filterLabel: 'Only variables that differ',
    columns: [
      { key: 'path', label: 'Variable' }, { key: 'status', label: 'Status' }, { key: 'dtypeA', label: 'Type A' }, { key: 'dtypeB', label: 'Type B' },
      { key: 'shapeA', label: 'Shape A' }, { key: 'shapeB', label: 'Shape B' }, { key: 'maxAbs', label: 'Max abs diff', type: 'num' },
      { key: 'meanAbs', label: 'Mean abs diff', type: 'num' }, { key: 'rmse', label: 'RMSE', type: 'num' }, { key: 'differing', label: 'Values that differ', type: 'int' },
      { key: 'fillMismatch', label: 'Fill mismatch', type: 'int' }, { key: 'maxAt', label: 'Max diff at' }, { key: 'attrs', label: 'Attributes that differ' },
      { key: 'note', label: 'Note' },
    ],
    rows,
  };
}

const describe = r => describeCompare(r);

module.exports = { describe, describeCompare };
