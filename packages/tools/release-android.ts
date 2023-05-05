import { execCommand } from '@joplin/utils';
import * as fs from 'fs-extra';
import { execCommandVerbose, execCommandWithPipes, githubRelease, githubOauthToken, fileExists, gitPullTry, completeReleaseWithChangelog } from './tool-utils';
const path = require('path');
const fetch = require('node-fetch');
const uriTemplate = require('uri-template');

const projectName = 'joplin-android';
const rootDir = path.dirname(path.dirname(__dirname));
const rnDir = `${rootDir}/packages/app-mobile`;
const releaseDir = `${rnDir}/dist`;

interface Release {
	downloadUrl: string;
	apkFilename: string;
	apkFilePath: string;
}

function increaseGradleVersionCode(content: string) {
	const newContent = content.replace(/versionCode\s+(\d+)/, (_a, versionCode: string) => {
		const n = Number(versionCode);
		if (isNaN(n) || !n) throw new Error(`Invalid version code: ${versionCode}`);
		return `versionCode ${n + 1}`;
	});

	if (newContent === content) throw new Error('Could not update version code');

	return newContent;
}

function increaseGradleVersionName(content: string) {
	const newContent = content.replace(/(versionName\s+"\d+?\.\d+?\.)(\d+)"/, (_match, prefix: string, buildNum: string) => {
		const n = Number(buildNum);
		if (isNaN(n)) throw new Error(`Invalid version code: ${buildNum}`);
		return `${prefix + (n + 1)}"`;
	});

	if (newContent === content) throw new Error('Could not update version name');

	return newContent;
}

function updateGradleConfig() {
	let content = fs.readFileSync(`${rnDir}/android/app/build.gradle`, 'utf8');
	content = increaseGradleVersionCode(content);
	content = increaseGradleVersionName(content);
	fs.writeFileSync(`${rnDir}/android/app/build.gradle`, content);
	return content;
}

function gradleVersionName(content: string) {
	const matches = content.match(/versionName\s+"(\d+?\.\d+?\.\d+)"/);
	if (!matches || matches.length < 1) throw new Error('Cannot get gradle version name');
	return matches[1];
}

async function createRelease(name: string, tagName: string, version: string): Promise<Release> {
	const originalContents: Record<string, string> = {};
	const suffix = version + (name === 'main' ? '' : `-${name}`);

	console.info(`Creating release: ${suffix}`);

	if (name === '32bit') {
		const filename = `${rnDir}/android/app/build.gradle`;
		let content = await fs.readFile(filename, 'utf8');
		originalContents[filename] = content;
		content = content.replace(/abiFilters "armeabi-v7a", "x86", "arm64-v8a", "x86_64"/, 'abiFilters "armeabi-v7a", "x86"');
		content = content.replace(/include "armeabi-v7a", "x86", "arm64-v8a", "x86_64"/, 'include "armeabi-v7a", "x86"');
		await fs.writeFile(filename, content);
	}

	if (name !== 'vosk') {
		{
			const filename = `${rnDir}/services/voiceTyping/vosk.js`;
			originalContents[filename] = await fs.readFile(filename, 'utf8');
			const newContent = await fs.readFile(`${rnDir}/services/voiceTyping/vosk.dummy.js`, 'utf8');
			await fs.writeFile(filename, newContent);
		}
		{
			const filename = `${rnDir}/package.json`;
			let content = await fs.readFile(filename, 'utf8');
			originalContents[filename] = content;
			content = content.replace(/\s+"@joplin\/react-native-vosk": ".*",/, '');
			await fs.writeFile(filename, content);
		}
	}

	const apkFilename = `joplin-v${suffix}.apk`;
	const apkFilePath = `${releaseDir}/${apkFilename}`;
	const downloadUrl = `https://github.com/laurent22/${projectName}/releases/download/${tagName}/${apkFilename}`;

	process.chdir(rootDir);

	console.info(`Running from: ${process.cwd()}`);

	console.info(`Building APK file v${suffix}...`);

	const buildDirName = `build-${name}`;
	const buildDirBasePath = `${rnDir}/android/app/${buildDirName}`;
	await fs.remove(buildDirBasePath);

	let restoreDir = null;
	let apkBuildCmd = '';
	const apkBuildCmdArgs = ['assembleRelease', `-PbuildDir=${buildDirName}`]; // TOOD: change build dir, delete before
	if (await fileExists('/mnt/c/Windows/System32/cmd.exe')) {
		await execCommandWithPipes('/mnt/c/Windows/System32/cmd.exe', ['/c', `cd packages\\app-mobile\\android && gradlew.bat ${apkBuildCmd}`]);
		apkBuildCmd = '';
	} else {
		process.chdir(`${rnDir}/android`);
		apkBuildCmd = './gradlew';
		restoreDir = rootDir;
	}

	if (apkBuildCmd) {
		await execCommandVerbose(apkBuildCmd, apkBuildCmdArgs);
	}

	if (restoreDir) process.chdir(restoreDir);

	await fs.mkdirp(releaseDir);

	const builtApk = `${buildDirBasePath}/outputs/apk/release/app-release.apk`;
	const builtApkStat = await fs.stat(builtApk);

	console.info(`Built APK at ${builtApk}`);
	console.info('APK size:', builtApkStat.size);

	console.info(`Copying APK to ${apkFilePath}`);
	await fs.copy(builtApk, apkFilePath);

	if (name === 'main') {
		console.info(`Copying APK to ${releaseDir}/joplin-latest.apk`);
		await fs.copy(builtApk, `${releaseDir}/joplin-latest.apk`);
	}

	for (const filename in originalContents) {
		const content = originalContents[filename];
		await fs.writeFile(filename, content);
	}

	return {
		downloadUrl: downloadUrl,
		apkFilename: apkFilename,
		apkFilePath: apkFilePath,
	};
}

async function main() {
	const argv = require('yargs').argv;

	await gitPullTry(false);

	const isPreRelease = !('type' in argv) || argv.type === 'prerelease';
	const releaseNameOnly = argv['release-name'];

	process.chdir(rnDir);
	await execCommand('yarn run build', { showStdout: false });

	if (isPreRelease) console.info('Creating pre-release');
	console.info('Updating version numbers in build.gradle...');

	const newContent = updateGradleConfig();
	const version = gradleVersionName(newContent);
	const tagName = `android-v${version}`;
	const releaseNames = ['main', '32bit', 'vosk'];
	const releaseFiles: Record<string, Release> = {};

	for (const releaseName of releaseNames) {
		if (releaseNameOnly && releaseName !== releaseNameOnly) continue;
		releaseFiles[releaseName] = await createRelease(releaseName, tagName, version);
	}

	console.info(`Creating GitHub release ${tagName}...`);

	const releaseOptions = { isPreRelease: isPreRelease };

	const oauthToken = await githubOauthToken();
	const release = await githubRelease(projectName, tagName, releaseOptions);
	const uploadUrlTemplate = uriTemplate.parse(release.upload_url);

	for (const releaseFilename in releaseFiles) {
		const releaseFile = releaseFiles[releaseFilename];
		const uploadUrl = uploadUrlTemplate.expand({ name: releaseFile.apkFilename });

		const binaryBody = await fs.readFile(releaseFile.apkFilePath);

		console.info(`Uploading ${releaseFile.apkFilename} to ${uploadUrl}`);

		const uploadResponse = await fetch(uploadUrl, {
			method: 'POST',
			body: binaryBody,
			headers: {
				'Content-Type': 'application/vnd.android.package-archive',
				'Authorization': `token ${oauthToken}`,
				'Content-Length': binaryBody.length,
			},
		});

		const uploadResponseText = await uploadResponse.text();
		const uploadResponseObject = JSON.parse(uploadResponseText);
		if (!uploadResponseObject || !uploadResponseObject.browser_download_url) throw new Error('Could not upload file to GitHub');
	}

	console.info(`Main download URL: ${releaseFiles['main'].downloadUrl}`);

	const changelogPath = `${rootDir}/readme/changelog_android.md`;
	await completeReleaseWithChangelog(changelogPath, version, tagName, 'Android', isPreRelease);
}

main().catch((error) => {
	console.error('Fatal error');
	console.error(error);
	process.exit(1);
});
