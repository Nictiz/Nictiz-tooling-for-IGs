const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const hash = contents => createHash('sha256').update(contents).digest('hex');
const hasSnapshot = profile => profile?.resourceType === 'StructureDefinition' &&
  Array.isArray(profile.snapshot?.element) && profile.snapshot.element.length > 0;

class ValidatorSnapshotGenerator {
  #validatorJar;

  constructor(validatorJar, execute = execFileSync) {
    if (validatorJar) {
      if (!fs.existsSync(validatorJar) || !fs.statSync(validatorJar).isFile()) {
        throw new Error(`Validator JAR not found at ${validatorJar}.`);
      }
      this.#validatorJar = validatorJar;
    } else {
      const defaultJar = path.resolve(path.join(process.cwd(), '..', 'validator_cli.jar'))
      if (!fs.existsSync(defaultJar) || !fs.statSync(defaultJar).isFile()) {
        throw new Error(`Validator JAR not found. Download it from https://github.com/hapifhir/org.hl7.fhir.core/releases, then place it in the parent of this folder or supply the location with the --validatorJar <path> flag.`);
      }
      this.#validatorJar = defaultJar;
    }

    try { execute('java', ['-version'], { stdio: 'pipe' }); } catch (error) {
      throw new Error(`Java is unavailable. Install Java and ensure it is on PATH. ${error.message}`);
    }
  }

  /**
   * Generate FHIR R4 snapshots in one synchronous validator invocation.
   * Copies all input profiles to a temporary directory and supplies their
   * unique original directories as -ig dependencies, converting only the
   * requested files. Reads the generated
   * JSON snapshots before removing the temporary directory, also on failure.
   * Original input files are never modified.
   *
   * @param {string[]} profiles Paths of profiles to convert; must occur in allProfiles.
   * @param {string[]} allProfiles Paths of additional profiles (XML or JSON) that
   *   whose containing directories should be considered for snapshot generation.
   * @param {string[]} packages FHIR packages passed as individual -ig arguments.
   * @param {Function} [execute=execFileSync] Synchronous command runner with the
   *   execFileSync signature; tests can inject a replacement to simulate Java.
   * @returns {Map<string, object>} Parsed snapshots keyed by original input path.
   * @throws {Error} If Java fails, output is missing or invalid JSON, or a file
   *   operation fails.
   */
  generateSnapshots(profiles, allProfiles, packages, execute = execFileSync) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-snapshots-'));
    try {
      const copies = new Map([...new Set(allProfiles)].map(filename => {
        const target = path.join(tempDir, path.basename(filename));
        fs.copyFileSync(filename, target);
        return [filename, target];
      }));
      const args = ['-jar', this.#validatorJar, 'snapshot', '-version', '4.0.1'];
      for (const ig of packages) args.push('-ig', ig);
      const directories = new Set(allProfiles.map(filename => path.dirname(path.resolve(filename))));
      for (const directory of directories) args.push('-ig', directory);
      args.push('-outputSuffix', 'snapshot.json', ...profiles.map(filename => copies.get(filename)));
      execute('java', args, { stdio: 'inherit' });
      return new Map(profiles.map(filename => {
        const source = copies.get(filename);
        const output = `${source}.snapshot.json`;
        return [filename, JSON.parse(fs.readFileSync(output, 'utf8'))];
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

class ProfileSnapshotCache {
  constructor(directory, { validatorJar, packages = [], execute = execFileSync } = {}) {
    this.directory = path.resolve(directory);
    this.validatorJar = validatorJar;
    this.packages = packages;
    this.execute = execute;
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

    // Check if a corresponding file is present and recent in the cache for each input file.
    const entries = filePaths.map(filePath => {
      // Get hash of input file
      filePath = path.resolve(filePath);
      const contents = fs.readFileSync(filePath);
      const digest = hash(contents);
      let inputProfile;
      try { inputProfile = JSON.parse(contents.toString('utf8').replace(/^\uFEFF/, '')); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      
      const filename = path.basename(filePath);
      const cacheFilePath = path.join(this.directory, filename.endsWith('.json') ? filename : `${filename}.json`);
      let profile;
      try { profile =  JSON.parse(fs.readFileSync(cacheFilePath, 'utf8')); } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      return { path: filePath, filename, digest, cacheFilePath, profile, contents, inputProfile,
        refresh: index.profiles[filename]?.hash !== digest || !hasSnapshot(profile) };
    });

    this.pendingRefresh = entries.filter(entry => entry.refresh).map(entry => entry.filename);
    let generated;
    const toGenerate = entries.filter(entry => entry.refresh && !hasSnapshot(entry.inputProfile));
    if (toGenerate.length) {
      const generator = new ValidatorSnapshotGenerator(this.validatorJar, this.execute);
      generated = generator.generateSnapshots(
        toGenerate.map(entry => entry.path),
        entries.map(entry => entry.path), this.packages, this.execute);
    }
    const results = new Map();
    for (const entry of entries) {
      try {
        if (entry.refresh) {
          const useInput = hasSnapshot(entry.inputProfile);
          entry.profile = useInput ? entry.inputProfile : generated.get(entry.path);
          if (!hasSnapshot(entry.profile)) {
            throw new Error('Snapshot generator must return a profile with snapshot.element');
          }
          fs.writeFileSync(entry.cacheFilePath, useInput ? entry.contents : JSON.stringify(entry.profile, null, 2) + '\n');
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

module.exports = { ProfileSnapshotCache, ValidatorSnapshotGenerator, hasSnapshot };
