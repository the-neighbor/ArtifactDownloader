// Importing required modules
import { Octokit } from "@octokit/rest";
import axios from "axios";
import fs from "fs";
import fetch from "node-fetch";
import path from "path";
import unzipper from "unzipper";
import { fileURLToPath } from 'url';

// Define __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Check if GitHub token, owner, and repo are provided as command line arguments
const [token, owner, repo, workflowName, artifactName] = process.argv.slice(2);

if (!token || !owner || !repo || !workflowName || !artifactName) {
    console.error("Usage: node downloadArtifacts.js <GITHUB_TOKEN> <OWNER> <REPO> <WORKFLOW_NAME> <ARTIFACT_NAME>");
    process.exit(1);
}

// Set up Octokit (GitHub API client) with the provided token
const octokit = new Octokit({ auth: token, request: {fetch:fetch} });

async function downloadArtifacts() {
    const downloadedBranches = []; // To store names of all downloaded branches
    try {
        //create artifacts folder
        const artifactsDir = path.join(__dirname, 'artifacts');
        fs.mkdirSync(artifactsDir, { recursive: true });
        // Get all workflow runs for the repository
        const runs = await octokit.actions.listWorkflowRunsForRepo({
            owner,
            repo,
        });
        console.log(`Found ${runs.data.workflow_runs.length} workflow runs`);


        // Group workflow runs by branch
        const branchRuns = {};
        for (const run of runs.data.workflow_runs) {
            const branch = run.head_branch;
            console.log('branch', branch);
            // If this is the first workflow run we've seen for the branch, or it's more recent, update the branchRuns
            if ((!branchRuns[branch] || Date(run.created_at) > Date(branchRuns[branch].created_at)) && run.name === workflowName) {
                branchRuns[branch] = run;
            }
        }

        console.log(branchRuns);
        const downloadArtifactsFromRun = async (branch) => {
            const run = branchRuns[branch];
            console.log(`Downloading artifacts for branch: ${branch}`);
            console.log(`Workflow run ID: ${run.id}`);
            // Get the list of artifacts for the most recent workflow run of the branch
            const artifacts = await octokit.actions.listWorkflowRunArtifacts({
                owner,
                repo,
                run_id: run.id,
            });
            console.log(`Found ${artifacts.data.artifacts.length} artifacts`);
            console.log(artifacts);
            // Download only the 'test-results' artifact
            for (const artifact of artifacts.data.artifacts) {
                console.log(artifact);
                if (artifact.name === artifactName) {
                    downloadedBranches.push(branchRuns[branch]);
                    const downloadUrl = await octokit.actions.downloadArtifact({
                        owner,
                        repo,
                        artifact_id: artifact.id,
                        archive_format: 'zip',
                    });

                    // Download the artifact and save it with the branch name
                    const filePath = path.join(artifactsDir, `${branch}.zip`);
                    const writer = fs.createWriteStream(filePath);

                    const artifactResponse = await axios({
                        url: downloadUrl.url,
                        method: 'GET',
                        responseType: 'stream',
                    });

                    artifactResponse.data.pipe(writer);

                    // Wait for the download to finish
                    await new Promise((resolve, reject) => {
                        writer.on('finish', async () => {
                            console.log(`Downloaded: ${branch}.zip`);

                            // Create a folder named after the branch and extract the zip
                            const extractDir = path.join(artifactsDir, branch);
                            fs.mkdirSync(extractDir, { recursive: true });

                            fs.createReadStream(filePath)
                                .pipe(unzipper.Extract({ path: extractDir }))
                                .on('close', () => {
                                    console.log(`Extracted: ${branch}`); // Add branch name to the list
                                });
                            resolve();
                        });

                        writer.on('error', (err) => {
                            console.error(`Error downloading ${artifact.name}: ${err.message}`);
                            reject(err);
                        });
                    });
                }
            }
        }

        // Iterate through the most recent workflow run for each branch
        const promises = Object.keys(branchRuns).map(downloadArtifactsFromRun)

        // Wait for all downloads to finish
        await Promise.all(promises);
        // After all downloads, write the list of branches to a JSON file
        const jsonFilePath = path.join(artifactsDir, 'branches.json');
        fs.writeFileSync(jsonFilePath, JSON.stringify(downloadedBranches, null, 2));
        console.log(`Branch list written to ${jsonFilePath}`);
    } catch (error) {
        console.error(error)
        console.error(`Error fetching artifacts: ${error.message}`);
    }
}

// Start the download process
downloadArtifacts();
