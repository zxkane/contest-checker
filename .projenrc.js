const { awscdk } = require('projen');

const awsSDKDeps = [
  '@aws-sdk/client-dynamodb',
  '@aws-sdk/client-sns',
  '@aws-sdk/client-lambda',
  '@aws-sdk/client-sts',
].map(dep => `${dep}@^3.30.0`);

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: '2.1.0',
  defaultReleaseBranch: 'main',
  name: 'contest-checker',

  deps: [
    '@types/aws-lambda@^8.10.89',
    '@aws-lambda-powertools/logger@^0.4.0',
    ...awsSDKDeps,
  ], /* Runtime dependencies of this module. */
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // devDeps: [],             /* Build dependencies for this module. */
  // packageName: undefined,  /* The "name" in package.json. */
});
project.synth();