const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const hash = contents => createHash('sha256').update(contents).digest('hex');

/** Placeholder until a snapshot generator is integrated. */
function generateSnapshot(filename) {
  throw new Error(`Snapshot generation is not implemented: ${filename}`);
}

class ProfileSnapshotCache {
  constructor(directory, generator = generateSnapshot) {
    this.directory = path.resolve(directory);
    this.generator = generator;
    this.pendingRefresh = [];
  }

  /** Gather all refreshes first, then load exclusively from cached snapshots.
   * Index keys are input filenames; hashes describe the original file bytes.
   * Only successfully generated snapshots receive a new index entry.
   */
  load(filePaths) {
    fs.mkdirSync(this.directory, { recursive: true });
    const indexPath = path.join(this.directory, 'index.json');
    const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { version: 1, profiles: {} };
    if (index.version !== 1 || !index.profiles || typeof index.profiles !== 'object' || Array.isArray(index.profiles)) {
      throw new Error(`Invalid snapshot cache index: ${indexPath}`);
    }
    const entries = filePaths.map(filePath => {
      // Get hash of input file
      filePath = path.resolve(filePath);
      const contents = fs.readFileSync(filePath);
      const digest = hash(contents);
      
      const filename = path.basename(filePath);
      const cacheFilePath = path.join(this.directory, filename.endsWith('.json') ? filename : `${filename}.json`);
      let profile;
      try { profile =  JSON.parse(fs.readFileSync(cacheFilePath, 'utf8')); } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      return { path: filePath, filename, digest, cacheFilePath, profile,
        refresh: index.profiles[filename]?.hash !== digest ||
          !Array.isArray(profile?.snapshot?.element) || !profile.snapshot.element.length };
    });
    this.pendingRefresh = entries.filter(entry => entry.refresh).map(entry => entry.filename);
    const results = new Map();
    for (const entry of entries) {
      try {
        if (entry.refresh) {
          entry.profile = this.generator(entry.path);
          if (!Array.isArray(entry.profile?.snapshot?.element) || !entry.profile.snapshot.element.length) {
            throw new Error('Snapshot generator must return a profile with snapshot.element');
          }
          fs.writeFileSync(entry.cacheFilePath, JSON.stringify(entry.profile, null, 2) + '\n');
          index.profiles[entry.filename] = { hash: entry.digest };
          fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
        }
        results.set(entry.path, { profile: entry.profile });
      } catch (error) {
        results.set(entry.path, { error });
      }
    }
    return results;
  }
}

module.exports = { ProfileSnapshotCache, generateSnapshot };
