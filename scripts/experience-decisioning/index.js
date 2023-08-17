/*
 * Copyright 2022 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import {
  getMetadata,
  sampleRUM,
  toCamelCase,
  toClassName,
} from '../lib-franklin.js';
// eslint-disable-next-line import/no-cycle
import { getAllMetadata } from '../scripts.js';

export const DEFAULT_OPTIONS = {
  campaignsMetaTagPrefix: 'campaign',
  campaignsQueryParameter: 'campaign',
  experimentsRoot: '/experiments',
  experimentsConfigFile: 'manifest.json',
  experimentsMetaTag: 'experiment',
  experimentsQueryParameter: 'experiment',
  rumSamplingRate: 10, // 1 in 10 requests
};

/**
 * Checks if the current engine is detected as being a bot.
 * @returns `true` if the current engine is detected as being, `false` otherwise
 */
function isBot() {
  return navigator.userAgent.match(/bot|crawl|spider/i);
}

/**
 * Parses the experimentation configuration sheet and creates an internal model.
 *
 * Output model is expected to have the following structure:
 *      {
 *        id: <string>,
 *        label: <string>,
 *        blocks: [<string>]
 *        audience: Desktop | Mobile,
 *        status: Active | Inactive,
 *        variantNames: [<string>],
 *        variants: {
 *          [variantName]: {
 *            label: <string>
 *            percentageSplit: <number 0-1>,
 *            pages: <string>,
 *            blocks: <string>,
 *          }
 *        }
 *      };
 */
function parseExperimentConfig(json) {
  const config = {};
  try {
    json.settings.data.forEach((line) => {
      const key = toCamelCase(line.Name);
      config[key] = line.Value;
    });
    const variants = {};
    let variantNames = Object.keys(json.experiences.data[0]);
    variantNames.shift();
    variantNames = variantNames.map((vn) => toCamelCase(vn));
    variantNames.forEach((variantName) => {
      variants[variantName] = {};
    });
    let lastKey = 'default';
    json.experiences.data.forEach((line) => {
      let key = toCamelCase(line.Name);
      if (!key) key = lastKey;
      lastKey = key;
      const vns = Object.keys(line);
      vns.shift();
      vns.forEach((vn) => {
        const camelVN = toCamelCase(vn);
        if (key === 'pages' || key === 'blocks') {
          variants[camelVN][key] = variants[camelVN][key] || [];
          if (key === 'pages') variants[camelVN][key].push(new URL(line[vn]).pathname);
          else variants[camelVN][key].push(line[vn]);
        } else {
          variants[camelVN][key] = line[vn];
        }
      });
    });
    config.variants = variants;
    config.variantNames = variantNames;
    return config;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('error parsing experiment config:', e, json);
  }
  return null;
}

export function isValidConfig(config) {
  if (!config.variantNames
    || !config.variantNames.length
    || !config.variants
    || !Object.values(config.variants).length
    || !Object.values(config.variants).every((v) => (
      typeof v === 'object'
      && !!v.blocks
      && !!v.pages
      && (v.percentageSplit === '' || !!v.percentageSplit)
    ))) {
    return false;
  }
  return true;
}

/**
 * Calculates percentage split for variants where the percentage split is not
 * explicitly configured.
 * Substracts from 100 the explicitly configured percentage splits,
 * and divides the remaining percentage, among the variants without explicit
 * percentage split configured
 * @param {Array} variant objects
 */
function inferEmptyPercentageSplits(variants) {
  const variantsWithoutPercentage = [];

  const remainingPercentage = variants.reduce((result, variant) => {
    if (!variant.percentageSplit) {
      variantsWithoutPercentage.push(variant);
    }
    const newResult = result - parseFloat(variant.percentageSplit || 0);
    return newResult;
  }, 1);
  if (variantsWithoutPercentage.length) {
    const missingPercentage = remainingPercentage / variantsWithoutPercentage.length;
    variantsWithoutPercentage.forEach((v) => {
      v.percentageSplit = missingPercentage.toFixed(2);
    });
  }
}

/**
 * Gets experiment config from the metadata.
 *
 * @param {string} experimentId The experiment identifier
 * @param {string} instantExperiment The list of varaints
 * @returns {object} the experiment manifest
 */
export function getConfigForInstantExperiment(experimentId, instantExperiment) {
  const config = {
    label: `Instant Experiment: ${experimentId}`,
    audience: '',
    status: 'Active',
    id: experimentId,
    variants: {},
    variantNames: [],
  };

  const pages = instantExperiment.split(',').map((p) => new URL(p.trim()).pathname);
  const evenSplit = 1 / (pages.length + 1);

  config.variantNames.push('control');
  config.variants.control = {
    percentageSplit: '',
    pages: [window.location.pathname],
    blocks: [],
    label: 'Control',
  };

  pages.forEach((page, i) => {
    const vname = `challenger-${i + 1}`;
    config.variantNames.push(vname);
    config.variants[vname] = {
      percentageSplit: `${evenSplit.toFixed(2)}`,
      pages: [page],
      blocks: [],
      label: `Challenger ${i + 1}`,
    };
  });
  inferEmptyPercentageSplits(Object.values(config.variants));
  return (config);
}

/**
 * Gets experiment config from the manifest and transforms it to more easily
 * consumable structure.
 *
 * the manifest consists of two sheets "settings" and "experiences", by default
 *
 * "settings" is applicable to the entire test and contains information
 * like "Audience", "Status" or "Blocks".
 *
 * "experience" hosts the experiences in rows, consisting of:
 * a "Percentage Split", "Label" and a set of "Links".
 *
 *
 * @param {string} experimentId The experiment identifier
 * @param {object} pluginOptions The plugin options
 * @returns {object} containing the experiment manifest
 */
export async function getConfigForFullExperiment(experimentId, pluginOptions) {
  const path = `${pluginOptions.experimentsRoot}/${experimentId}/${pluginOptions.experimentsConfigFile}`;
  try {
    const resp = await fetch(path);
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.log('error loading experiment config:', resp);
      return null;
    }
    const json = await resp.json();
    const config = pluginOptions.parser
      ? pluginOptions.parser.call(this, json)
      : parseExperimentConfig.call(this, json);
    if (!config) {
      return null;
    }
    config.id = experimentId;
    config.manifest = path;
    config.basePath = `${pluginOptions.experimentsRoot}/${experimentId}`;
    inferEmptyPercentageSplits(Object.values(config.variants));
    return config;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`error loading experiment manifest: ${path}`, e);
  }
  return null;
}

function getDecisionPolicy(config) {
  const decisionPolicy = {
    id: 'content-experimentation-policy',
    rootDecisionNodeId: 'n1',
    decisionNodes: [{
      id: 'n1',
      type: 'EXPERIMENTATION',
      experiment: {
        id: config.id,
        identityNamespace: 'ECID',
        randomizationUnit: 'DEVICE',
        treatments: Object.entries(config.variants).map(([key, props]) => ({
          id: key,
          allocationPercentage: props.percentageSplit,
        })),
      },
    }],
  };
  return decisionPolicy;
}

/**
 * this is an extensible stub to take on audience mappings
 * @param {string} audience
 * @return {boolean} is member of this audience
 */
function isValidAudience(audience) {
  if (audience === 'mobile') {
    return window.innerWidth < 600;
  }
  if (audience === 'desktop') {
    return window.innerWidth >= 600;
  }
  return true;
}

/**
 * Replaces element with content from path
 * @param {string} path
 * @param {HTMLElement} element
 * @param {boolean} isBlock
 */
async function replaceInner(path, element) {
  const plainPath = `${path}.plain.html`;
  try {
    const resp = await fetch(plainPath);
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.log('error loading experiment content:', resp);
      return false;
    }
    const html = await resp.text();
    // eslint-disable-next-line no-param-reassign
    element.innerHTML = html;
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`error loading experiment content: ${plainPath}`, e);
  }
  return false;
}

export async function getConfig(experiment, instantExperiment, pluginOptions) {
  const usp = new URLSearchParams(window.location.search);
  const [forcedExperiment, forcedVariant] = usp.has(pluginOptions.queryParameter)
    ? usp.get(pluginOptions.queryParameter).split('/')
    : [];

  const experimentConfig = instantExperiment
    ? await getConfigForInstantExperiment(experiment, instantExperiment)
    : await getConfigForFullExperiment(experiment, pluginOptions);
  // eslint-disable-next-line no-console
  console.debug(experimentConfig);
  if (!experimentConfig || (toCamelCase(experimentConfig.status) !== 'active' && !forcedExperiment)) {
    return null;
  }

  experimentConfig.run = !!forcedExperiment
    || isValidAudience(toClassName(experimentConfig.audience));
  if (!experimentConfig.run) {
    return null;
  }

  window.hlx = window.hlx || {};
  window.hlx.experiment = experimentConfig;
  // eslint-disable-next-line no-console
  console.debug('run', experimentConfig.run, experimentConfig.audience);
  if (forcedVariant && experimentConfig.variantNames.includes(forcedVariant)) {
    experimentConfig.selectedVariant = forcedVariant;
  } else {
    // eslint-disable-next-line import/extensions
    const { ued } = await import('./ued.js');
    const decision = ued.evaluateDecisionPolicy(getDecisionPolicy(experimentConfig), {});
    experimentConfig.selectedVariant = decision.items[0].id;
  }
  return experimentConfig;
}

export async function runExperiment(customOptions = {}) {
  if (isBot()) {
    return false;
  }

  const pluginOptions = { ...DEFAULT_OPTIONS, ...customOptions };
  const experiment = getMetadata(pluginOptions.experimentsMetaTag);
  if (!experiment) {
    return false;
  }
  const variants = getMetadata('instant-experiment') || getMetadata('experiment-variants');
  let experimentConfig;
  try {
    experimentConfig = await getConfig(experiment, variants, pluginOptions);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Invalid experiment config.', err);
  }
  if (!experimentConfig || !isValidConfig(experimentConfig)) {
    // eslint-disable-next-line no-console
    console.warn('Invalid experiment config. Please review your metadata, sheet and parser.');
    return false;
  }
  // eslint-disable-next-line no-console
  console.debug(`running experiment (${window.hlx.experiment.id}) -> ${window.hlx.experiment.selectedVariant}`);

  if (experimentConfig.selectedVariant === experimentConfig.variantNames[0]) {
    return false;
  }

  const { pages } = experimentConfig.variants[experimentConfig.selectedVariant];
  if (!pages.length) {
    return false;
  }

  const currentPath = window.location.pathname;
  const control = experimentConfig.variants[experimentConfig.variantNames[0]];
  const index = control.pages.indexOf(currentPath);
  if (index < 0 || pages[index] === currentPath) {
    return false;
  }

  // Fullpage content experiment
  document.body.classList.add(`experiment-${experimentConfig.id}`);
  const result = await replaceInner(pages[0], document.querySelector('main'));
  if (!result) {
    // eslint-disable-next-line no-console
    console.debug(`failed to serve variant ${window.hlx.experiment.selectedVariant}. Falling back to ${experimentConfig.variantNames[0]}.`);
  }
  document.body.classList.add(`variant-${result ? experimentConfig.selectedVariant : experimentConfig.variantNames[0]}`);
  sampleRUM('experiment', {
    source: experimentConfig.id,
    target: result ? experimentConfig.selectedVariant : experimentConfig.variantNames[0],
  });
  return result;
}

export async function runCampaign(customOptions) {
  if (isBot()) {
    return null;
  }

  const options = { ...DEFAULT_OPTIONS, ...customOptions };
  const usp = new URLSearchParams(window.location.search);
  const campaign = usp.has(options.campaignsQueryParameter)
    ? toClassName(usp.get(options.campaignsQueryParameter))
    : null;
  if (!campaign) {
    return null;
  }

  const allowedCampaigns = getAllMetadata(options.campaignsMetaTagPrefix);
  if (!Object.keys(allowedCampaigns).includes(campaign)) {
    return null;
  }

  const urlString = allowedCampaigns[campaign];
  if (!urlString) {
    return null;
  }

  try {
    const url = new URL(urlString);
    return replaceInner(url.pathname, document.querySelector('main'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    return null;
  }
}

window.hlx.patchBlockConfig.push((config) => {
  const { experiment } = window.hlx;

  // No experiment is running
  if (!experiment || !experiment.run) {
    return config;
  }

  // The current experiment does not modify the block
  if (experiment.selectedVariant === experiment.variantNames[0]
    || !experiment.blocks || !experiment.blocks.includes(config.blockName)) {
    return config;
  }

  // The current experiment does not modify the block code
  const variant = experiment.variants[experiment.selectedVariant];
  if (!variant.blocks.length) {
    return config;
  }

  let index = experiment.variants[experiment.variantNames[0]].blocks.indexOf('');
  if (index < 0) {
    index = experiment.variants[experiment.variantNames[0]].blocks.indexOf(config.blockName);
  }
  if (index < 0) {
    index = experiment.variants[experiment.variantNames[0]].blocks.indexOf(`/blocks/${config.blockName}`);
  }
  if (index < 0) {
    return config;
  }

  let origin = '';
  let path;
  if (/^https?:\/\//.test(variant.blocks[index])) {
    const url = new URL(variant.blocks[index]);
    // Experimenting from a different branch
    if (url.origin !== window.location.origin) {
      origin = url.origin;
    }
    // Experimenting from a block path
    if (url.pathname !== '/') {
      path = url.pathname;
    } else {
      path = `/blocks/${config.blockName}`;
    }
  } else { // Experimenting from a different branch on the same branch
    path = variant.blocks[index];
  }
  if (!origin && !path) {
    return config;
  }

  const { codeBasePath } = window.hlx;
  return {
    ...config,
    cssPath: `${origin}${codeBasePath}${path}/${config.blockName}.css`,
    jsPath: `${origin}${codeBasePath}${path}/${config.blockName}.js`,
  };
});

function adjustedRumSamplingRate(customOptions) {
  const pluginOptions = { ...DEFAULT_OPTIONS, ...customOptions };
  return (data, sendPing) => {
    // track experiments with higher sampling rate
    window.hlx.rum.weight = Math.min(window.hlx.rum.weight, pluginOptions.rumSamplingRate);
    window.hlx.rum.isSelected = (window.hlx.rum.random * window.hlx.rum.weight < 1);

    sampleRUM.drain('stash', sampleRUM);
    sendPing(data);
    return true;
  };
}

export async function loadEager(customOptions = {}) {
  sampleRUM.cases ||= {};
  sampleRUM.cases.experiment = adjustedRumSamplingRate(customOptions);
  await runExperiment(customOptions);
  await runCampaign(customOptions);
}

export async function loadLazy(customOptions = {}) {
  const pluginOptions = {
    ...DEFAULT_OPTIONS,
    ...customOptions,
  };
  const preview = await import('./preview.js');
  preview.default(pluginOptions);
}
