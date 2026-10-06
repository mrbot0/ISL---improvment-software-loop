/**
 * Re-export of the scope analysis that the pipeline itself uses.
 *
 * The implementation lives in `src/iteration/staticAnalysis.js` because the scope gate runs on
 * every iteration and cannot import from a tools directory. Keeping this file as a thin re-export
 * means the standalone scans, the test guard and the live gate can never drift apart.
 */
export { stripNonCode, boundNames, calledNames, duplicateClassMembers } from '../src/iteration/staticAnalysis.js';
