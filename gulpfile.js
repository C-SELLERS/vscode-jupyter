/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* jshint node: true */
/* jshint esversion: 6 */

'use strict';

const gulp = require('gulp');
const glob = require('glob');
const spawn = require('cross-spawn');
const path = require('path');
const del = require('del');
const fs = require('fs-extra');
const _ = require('lodash');
const nativeDependencyChecker = require('node-has-native-dependencies');
const flat = require('flat');
const os = require('os');
const { spawnSync } = require('child_process');
const isCI = process.env.TF_BUILD !== undefined || process.env.GITHUB_ACTIONS === 'true';
const webpackEnv = { NODE_OPTIONS: '--max_old_space_size=9096' };

gulp.task('compile', async (done) => {
    // Use tsc so we can generate source maps that look just like tsc does (gulp-sourcemap does not generate them the same way)
    try {
        const stdout = await spawnAsync('tsc', ['-p', './'], {}, true);
        if (stdout.toLowerCase().includes('error ts')) {
            throw new Error(`Compile errors: \n${stdout}`);
        }
        done();
    } catch (e) {
        done(e);
    }
});

gulp.task('createNycFolder', async (done) => {
    try {
        const fs = require('fs');
        fs.mkdirSync(path.join(__dirname, '.nyc_output'));
    } catch (e) {
        //
    }
    done();
});

gulp.task('validateTranslationFiles', (done) => {
    glob.sync('package.nls.*.json', { sync: true }).forEach((file) => {
        // Verify we can open and parse as JSON.
        try {
            JSON.parse(fs.readFileSync(file));
        } catch (ex) {
            throw new Error(`Error parsing Translation File ${file}`);
        }
    });
    done();
});

gulp.task('output:clean', () => del(['coverage']));

gulp.task('clean:cleanExceptTests', () => del(['clean:vsix', 'out', '!out/test']));
gulp.task('clean:vsix', () => del(['*.vsix']));
gulp.task('clean:out', () => del(['out/**', '!out', '!out/client_renderer/**']));

gulp.task('clean', gulp.parallel('output:clean', 'clean:vsix', 'clean:out'));

gulp.task('checkNativeDependencies', (done) => {
    if (hasNativeDependencies()) {
        done(new Error('Native dependencies detected'));
    }
    done();
});
gulp.task('checkNpmDependencies', (done) => {
    /**
     * Sometimes we have to update the package-lock.json file to upload dependencies.
     * Thisscript will ensure that even if the package-lock.json is re-generated the (minimum) version numbers are still as expected.
     */
    const packageLock = require('./package-lock.json');
    const errors = [];

    const expectedVersions = [
        { name: 'trim', version: '0.0.3' },
        { name: 'node_modules/trim', version: '0.0.3' }
    ];
    function checkPackageVersions(packages, parent) {
        if (!packages) {
            return;
        }
        expectedVersions.forEach((expectedVersion) => {
            if (!packages[expectedVersion.name]) {
                return;
            }
            const version = packages[expectedVersion.name].version || packages[expectedVersion.name];
            if (!version) {
                return;
            }
            if (!version.includes(expectedVersion.version)) {
                errors.push(
                    `${expectedVersion.name} version needs to be at least ${
                        expectedVersion.version
                    }, current ${version}, ${parent ? `(parent package ${parent})` : ''}`
                );
            }
        });
    }
    function checkPackageDependencies(packages) {
        if (!packages) {
            return;
        }
        Object.keys(packages).forEach((packageName) => {
            const dependencies = packages[packageName]['dependencies'];
            if (dependencies) {
                checkPackageVersions(dependencies, packageName);
            }
        });
    }

    checkPackageVersions(packageLock['packages']);
    checkPackageVersions(packageLock['dependencies']);
    checkPackageDependencies(packageLock['packages']);

    if (errors.length > 0) {
        errors.forEach((ex) => console.error(ex));
        throw new Error(errors.join(', '));
    }
    done();
});

gulp.task('installPythonLibs', async () => {
    const output = spawnSync(
        'python -m pip --disable-pip-version-check install -t ./pythonFiles/lib/python --no-cache-dir --implementation py --no-deps --upgrade -r ./requirements.txt'
    );
    if (output.error) {
        console.error(output.stderr);
        throw output.error;
    }
});

gulp.task('compile-renderers', async () => {
    console.log('Building renderers');
    await buildWebPackForDevOrProduction('./build/webpack/webpack.datascience-ui-renderers.config.js');
});

gulp.task('compile-viewers', async () => {
    await buildWebPackForDevOrProduction('./build/webpack/webpack.datascience-ui-viewers.config.js');
});

gulp.task('compile-webextension', async () => {
    await buildWebPackForDevOrProduction('./build/webpack/webpack.extension.web.config.js');
});
gulp.task('compile-webviews', gulp.parallel('compile-viewers', 'compile-renderers', 'compile-webextension'));

async function buildWebPackForDevOrProduction(configFile, configNameForProductionBuilds) {
    if (configNameForProductionBuilds) {
        await buildWebPack(configNameForProductionBuilds, ['--config', configFile], webpackEnv);
    } else {
        console.log('Building ipywidgets in dev mode');
        await spawnAsync('npm', ['run', 'webpack', '--', '--config', configFile, '--mode', 'development'], webpackEnv);
    }
}
gulp.task('webpack', async () => {
    // Build node_modules.
    await buildWebPackForDevOrProduction('./build/webpack/webpack.extension.dependencies.config.js', 'production');
    // Build DS stuff (separately as it uses far too much memory and slows down CI).
    // Individually is faster on CI.
    await buildWebPackForDevOrProduction('./build/webpack/webpack.datascience-ui-renderers.config.js', 'production');
    await buildWebPackForDevOrProduction('./build/webpack/webpack.datascience-ui-viewers.config.js', 'production');
    await buildWebPackForDevOrProduction('./build/webpack/webpack.extension.node.config.js', 'extension');
    await buildWebPackForDevOrProduction('./build/webpack/webpack.extension.web.config.js', 'extension');
});

gulp.task('updateBuildNumber', async () => {
    await updateBuildNumber();
});

async function updateBuildNumber() {
    // Edit the version number from the package.json
    const packageJsonContents = await fs.readFile('package.json', 'utf-8');
    const packageJson = JSON.parse(packageJsonContents);

    // Change version number
    // 3rd part of version is limited to Max Int32 numbers (in VSC Marketplace).
    // Hence build numbers can only be YYYY.MMM.2147483647
    // NOTE: For each of the following strip the first 3 characters from the build number.
    //  E.g. if we have build number of `build number = 3264527301, then take 4527301

    // To ensure we can have point releases & insider builds, we're going with the following format:
    // Insider & Release builds will be YYYY.MMM.100<build number>
    // When we have a hot fix, we update the version to YYYY.MMM.110<build number>
    // If we have more hot fixes, they'll be YYYY.MMM.120<build number>, YYYY.MMM.130<build number>, & so on.

    const versionParts = packageJson.version.split('.');
    // New build is of the form `DDDHHMM` (day of year, hours, minute) (7 digits, as out of the 10 digits first three are reserved for `100` or `101` for patches).
    // Use date time for build, this way all subsequent builds are incremental and greater than the others before.
    // Example build for 3Jan 12:45 will be `0031245`, and 16 Feb 8:50 will be `0470845`
    const today = new Date();
    const dayCount = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    const dayOfYear = dayCount[today.getMonth()] + today.getDate() + 1;
    const buildNumberSuffix = `${dayOfYear.toString().padStart(3, '0')}${(today.getHours() + 1)
        .toString()
        .padStart(2, '0')}${(today.getMinutes() + 1).toString().padStart(2, '0')}`;
    const buildNumber = `${versionParts[2].substring(0, 3)}${buildNumberSuffix}`;
    const newVersion =
        versionParts.length > 1 ? `${versionParts[0]}.${versionParts[1]}.${buildNumber}` : packageJson.version;
    packageJson.version = newVersion;

    // Write back to the package json
    await fs.writeFile('package.json', JSON.stringify(packageJson, null, 4), 'utf-8');
}

async function buildWebPack(webpackConfigName, args, env) {
    // Remember to perform a case insensitive search.
    const allowedWarnings = getAllowedWarningsForWebPack(webpackConfigName).map((item) => item.toLowerCase());
    const stdOut = await spawnAsync(
        'npm',
        ['run', 'webpack', '--', ...args, ...['--mode', 'production', '--devtool', 'source-map']],
        env
    );
    const stdOutLines = stdOut
        .split(os.EOL)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    // Remember to perform a case insensitive search.
    const warnings = stdOutLines
        .filter((item) => item.startsWith('WARNING in '))
        .filter(
            (item) =>
                allowedWarnings.findIndex((allowedWarning) =>
                    item.toLowerCase().startsWith(allowedWarning.toLowerCase())
                ) == -1
        );
    const errors = stdOutLines.some((item) => item.startsWith('ERROR in'));
    if (errors) {
        throw new Error(`Errors in ${webpackConfigName}, \n${warnings.join(', ')}\n\n${stdOut}`);
    }
    if (warnings.length > 0) {
        throw new Error(
            `Warnings in ${webpackConfigName}, Check gulpfile.js to see if the warning should be allowed., \n\n${stdOut}`
        );
    }
}
function getAllowedWarningsForWebPack(buildConfig) {
    switch (buildConfig) {
        case 'production':
            return [
                'WARNING in asset size limit: The following asset(s) exceed the recommended size limit (244 KiB).',
                'WARNING in entrypoint size limit: The following entrypoint(s) combined asset size exceeds the recommended limit (244 KiB). This can impact web performance.',
                'WARNING in webpack performance recommendations:',
                'WARNING in ./node_modules/encoding/lib/iconv-loader.js',
                'WARNING in ./node_modules/keyv/src/index.js',
                'ERROR in ./node_modules/got/index.js',
                'WARNING in ./node_modules/ws/lib/BufferUtil.js',
                'WARNING in ./node_modules/ws/lib/buffer-util.js',
                'WARNING in ./node_modules/ws/lib/Validation.js',
                'WARNING in ./node_modules/ws/lib/validation.js',
                'WARNING in ./node_modules/@jupyterlab/services/node_modules/ws/lib/buffer-util.js',
                'WARNING in ./node_modules/@jupyterlab/services/node_modules/ws/lib/validation.js',
                'WARNING in ./node_modules/any-promise/register.js',
                'WARNING in ./node_modules/log4js/lib/appenders/index.js',
                'WARNING in ./node_modules/log4js/lib/clustering.js',
                'WARNING in ./node_modules/diagnostic-channel-publishers/dist/src/azure-coretracing.pub.js',
                'WARNING in ./node_modules/applicationinsights/out/AutoCollection/NativePerformance.js'
            ];
        case 'extension':
            return [
                'WARNING in asset size limit: The following asset(s) exceed the recommended size limit (244 KiB).',
                'WARNING in entrypoint size limit: The following entrypoint(s) combined asset size exceeds the recommended limit (244 KiB). This can impact web performance.',
                'WARNING in webpack performance recommendations:',
                'WARNING in ./node_modules/cacheable-request/node_modules/keyv/src/index.js',
                'WARNING in ./node_modules/encoding/lib/iconv-loader.js',
                'WARNING in ./node_modules/keyv/src/index.js',
                'WARNING in ./node_modules/ws/lib/BufferUtil.js',
                'WARNING in ./node_modules/ws/lib/buffer-util.js',
                'WARNING in ./node_modules/ws/lib/Validation.js',
                'WARNING in ./node_modules/ws/lib/validation.js',
                'WARNING in ./node_modules/any-promise/register.js',
                'remove-files-plugin@1.4.0:',
                'WARNING in ./node_modules/@jupyterlab/services/node_modules/ws/lib/buffer-util.js',
                'WARNING in ./node_modules/@jupyterlab/services/node_modules/ws/lib/validation.js',
                'WARNING in ./node_modules/@jupyterlab/services/node_modules/ws/lib/Validation.js',
                'WARNING in ./node_modules/diagnostic-channel-publishers/dist/src/azure-coretracing.pub.js',
                'WARNING in ./node_modules/applicationinsights/out/AutoCollection/NativePerformance.js'
            ];
        case 'debugAdapter':
            return [
                'WARNING in ./node_modules/vscode-uri/lib/index.js',
                'WARNING in ./node_modules/diagnostic-channel-publishers/dist/src/azure-coretracing.pub.js',
                'WARNING in ./node_modules/applicationinsights/out/AutoCollection/NativePerformance.js'
            ];
        default:
            throw new Error('Unknown WebPack Configuration');
    }
}

gulp.task('prePublishBundle', gulp.series('webpack'));
gulp.task('checkDependencies', gulp.series('checkNativeDependencies', 'checkNpmDependencies'));
gulp.task('prePublishNonBundle', gulp.parallel('compile', gulp.series('compile-webviews')));

function spawnAsync(command, args, env, rejectOnStdErr = false) {
    env = env || {};
    env = { ...process.env, ...env };
    return new Promise((resolve, reject) => {
        let stdOut = '';
        console.info(`> ${command} ${args.join(' ')}`);
        const proc = spawn(command, args, { cwd: __dirname, env });
        proc.stdout.on('data', (data) => {
            // Log output on CI (else travis times out when there's not output).
            stdOut += data.toString();
            if (isCI) {
                console.log(data.toString());
            }
        });
        proc.stderr.on('data', (data) => {
            console.error(data.toString());
            if (rejectOnStdErr) {
                reject(data.toString());
            }
        });
        proc.on('close', () => resolve(stdOut));
        proc.on('error', (error) => reject(error));
    });
}

function hasNativeDependencies() {
    let nativeDependencies = nativeDependencyChecker.check(path.join(__dirname, 'node_modules'));
    if (!Array.isArray(nativeDependencies) || nativeDependencies.length === 0) {
        return false;
    }
    const dependencies = JSON.parse(spawn.sync('npm', ['ls', '--json', '--prod']).stdout.toString());
    const jsonProperties = Object.keys(flat.flatten(dependencies));
    nativeDependencies = _.flatMap(nativeDependencies, (item) =>
        path.dirname(item.substring(item.indexOf('node_modules') + 'node_modules'.length)).split(path.sep)
    )
        .filter((item) => item.length > 0)
        .filter((item) => !item.includes('zeromq') && !item.includes('canvas') && !item.includes('keytar')) // Known native modules
        .filter(
            (item) =>
                jsonProperties.findIndex((flattenedDependency) =>
                    flattenedDependency.endsWith(`dependencies.${item}.version`)
                ) >= 0
        );
    if (nativeDependencies.length > 0) {
        console.error('Native dependencies detected', nativeDependencies);
        return true;
    }
    return false;
}

gulp.task('generateTelemetryMd', async () => {
    const generator = require('./out/platform/tools/telemetryGenerator.node');
    return generator.default();
});
