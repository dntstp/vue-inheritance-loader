const fs = require('fs');
const path = require('path');
const compiler = require('vue-template-compiler');
const htmlparser = require("htmlparser2");
const {parse} = require('@vue/component-compiler-utils');
const {getOptions} = require('loader-utils');
const schema = require('./options.json');
const validateOptions = require('schema-utils');

const defaultOptions = {
  EXT_POINT_TAG: 'extension-point',
  EXTENSIONS_TAG: 'extensions',
  EXTENSION_TAG: 'extension',
  EXT_POINT_NAME_ATTR: 'name',
  EXT_POINT_REF_ATTR: 'point',
  EXTENDABLE_ATTR: 'extendable',
  EXTENDS_ATTR: 'extends'
};
let options = defaultOptions;

const loader = function (source, map) {
  options = {...defaultOptions, ...getOptions(this)};
  validateOptions(schema, options, 'vue-inheritance-loader');

  let callback = this.async();
  let aliases = this._compiler.options.resolve.alias;
  getMergedCode(source, this.context, aliases).then(result => {
    // To make HMR aware of the base file and reload it when it changes
    result.ancestorsPaths.forEach(ancestor => {
      this.addDependency(ancestor);
    });

    callback(null,
      result.source,
      map);
  }, error => {
    callback(error)
  });
};

const getMergedCode = function (source, currPath, aliases) {
  return new Promise((resolve, reject) => {
    resolveComponent(source, currPath, aliases).then(({source, ancestorsPaths}) => {

      // Remove comment lines at beginning of script block that were generated by the SFC parser
      let finalDescriptor = toDescriptor(source);
      if (finalDescriptor.script) {
        finalDescriptor.script.content = finalDescriptor.script.content.replace(/^(\/\/\n)+/, '')
      }

      // Change all extension points to <template> on the final component to display fallback content
      if (finalDescriptor.template && finalDescriptor.template.attrs[options.EXTENDABLE_ATTR]) {
        let finalDom = parseDOM(finalDescriptor.template.content);
        findDomElementsByTagName(finalDom, options.EXT_POINT_TAG).forEach(ext => {
          ext.name = 'template';
          delete ext.attribs[options.EXT_POINT_NAME_ATTR]
        });
        source = `<template>
                    ${htmlparser.DomUtils.getOuterHTML(finalDom)}
                  </template> 
                  ${descriptorToHTML(finalDescriptor)}`;
      }

      resolve({source, ancestorsPaths});
    }, error => {
      reject(error)
    });
  })
};

function resolveComponent(currentSource, currPath, aliases) {
  return new Promise((resolve, reject) => {
    try {
      let currentDesc = toDescriptor(currentSource);

      // If the component extends another, resolve its source merging it with the base component
      // else return code as is
      if (currentDesc.template && currentDesc.template.attrs[options.EXTENDS_ATTR]) {
        let baseRelPath = currentDesc.template.attrs[options.EXTENDS_ATTR];
        let baseRelPathParts = baseRelPath.split(/[\/\\]/);

        // If there's a matching alias, use it. If not, use the context path
        // __fromJest is a flag inserted on vue-inheritance-loader-jest
        if(aliases['__fromJest']){
          var matchingAlias = Object.keys(aliases).find(k => {
            let regex = new RegExp(k);
            return regex.test(baseRelPath);
          });
        }else{
          var matchingAlias = Object.keys(aliases).find(k => baseRelPathParts[0] === k);
        }

        if (matchingAlias) {
          if(aliases['__fromJest']){
            var baseAbsPath = baseRelPath.replace(new RegExp(matchingAlias), aliases[matchingAlias])
          }else{
            baseRelPathParts.shift();
            baseRelPath = baseRelPathParts.join('/');
            var baseAbsPath = path.join(aliases[matchingAlias], baseRelPath);
          }
        } else {
          var baseAbsPath = path.join(currPath, baseRelPath);
        }

        fs.readFile(baseAbsPath, 'utf8', (err, contents) => {
          // File read error, reject
          if (err) reject(err);

          // Resolve the base component recursively to support inheritance in N levels
          let basePath = path.dirname(baseAbsPath);
          resolveComponent(contents, basePath, aliases).then(({source, ancestorsPaths}) => {
            try {
              // Add this ancestor to the ancestors return array
              ancestorsPaths.push(baseAbsPath);

              let baseDescriptor = toDescriptor(source);

              let baseDom = parseDOM(baseDescriptor.template.content);
              let currentDom = parseDOM(currentDesc.template.content);

              // Get all the child's component extensions
              let extensions = currentDom.find(node => node.type = 'tag' && node.name === options.EXTENSIONS_TAG).children
                .filter(node => node.type = 'tag' && node.name === options.EXTENSION_TAG);

              // Replace each of the Base component's extension points with the child's extensions
              findDomElementsByTagName(baseDom, options.EXT_POINT_TAG).forEach(extPoint => {
                // Find the extend block for the current extension point
                let extendBlock = extensions.find(node => node.attribs[options.EXT_POINT_REF_ATTR] === extPoint.attribs[options.EXT_POINT_NAME_ATTR]);

                // If a extend block matching the extension point was found, replace the point's content with the extend block's
                if (extendBlock) {
                  extPoint.children = extendBlock.children;

                  // Change extension point tag to a template tag
                  extPoint.name = 'template';
                  delete extPoint.attribs[options.EXT_POINT_NAME_ATTR];
                }
              });

              // Resolve promise with the new generated SFC
              resolve({
                source: `<template ${options.EXTENDABLE_ATTR}>
                           ${htmlparser.DomUtils.getOuterHTML(baseDom)}
                         </template> 
                         ${descriptorToHTML(currentDesc)}`,
                ancestorsPaths
              });
            } catch (e) {
              reject(e)
            }
          }, e => {
            reject(e)
          });
        });
      } else {
        resolve({source: currentSource, ancestorsPaths: []});
      }
    } catch (e) {
      reject(e)
    }
  })
}

/**
 * Returns the SFC descriptor for a given SFC sourcecode
 * @param source
 */
function parseDOM(source) {
  // Use recognizeSelfClosing option to handle tags like <spacer />
  // Disable lowerCaseTags option to avoid turning things like MyComponent to mycomponent
  return htmlparser.parseDOM(source, {recognizeSelfClosing: true, lowerCaseTags: false});
}

/**
 * Returns the SFC descriptor for a given SFC sourcecode
 * @param source
 */
function toDescriptor(source) {
  return parse({
    source: source,
    compiler,
    needMap: false
  });
}

function findDomElementsByTagName(dom, tag) {
  return htmlparser.DomUtils.findAll(node => (node.type === 'tag' && node.name === tag), dom)
}

/**
 * Given a SFC's descriptor, returns the SFC's source **without** the template part
 * @param descriptor - SFC descriptor
 * @returns {string} - SFC source code
 */
function descriptorToHTML(descriptor) {
  return descriptor.customBlocks
      .filter(cb => cb.type !== options.EXTENSION_TAG)
      .map(cb => blockToHTML(cb))
      .join('\n') +
    blockToHTML(descriptor.script) +
    descriptor.styles
      .map(cb => blockToHTML(cb))
      .join('\n');
}

function blockToHTML(block) {
  if (block) {
    let attrToHtmlAttr = ([key, value]) => ` ${key}="${value}" `;
    let attrs = Object.entries(block.attrs).reduce((accum, curr) => accum + attrToHtmlAttr(curr), '');
    return `<${block.type} ${attrs}>${block.content}</${block.type}>`
  }
}


exports.default = loader
exports.resolve = getMergedCode