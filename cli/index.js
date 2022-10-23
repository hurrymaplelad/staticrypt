#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const Yargs = require("yargs");
const { subtle, getRandomValues } = require("crypto").webcrypto;
const { readFileSync, writeFileSync } = require("fs");
const { join } = require("path");
const { usage, showHelp } = require("yargs");
const { webcrypto } = require("crypto");

const getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
const subtle = webcrypto.subtle;

/**
 * Salt and encrypt a msg with a password.
 * Inspired by https://github.com/adonespitogo
 */
function encrypt(msg, hashedPassphrase) {
  var iv = CryptoJS.lib.WordArray.random(128 / 8);
  var encrypted = CryptoJS.AES.encrypt(msg, hashedPassphrase, {
    iv: iv,
    padding: CryptoJS.pad.Pkcs7,
    mode: CryptoJS.mode.CBC,
  });

  // iv will be hex 16 in length (32 characters)
  // we prepend it to the ciphertext for use in decryption
  return iv.toString() + encrypted.toString();
}

/**
 * Salt and hash the passphrase so it can be stored in localStorage without opening a password reuse vulnerability.
 *
 * @param {string} passphrase
 * @param {string} salt
 * @returns string
 */
function hashPassphrase(passphrase, salt) {
  var hashedPassphrase = CryptoJS.PBKDF2(passphrase, salt, {
    keySize: 256 / 32,
    iterations: 1000,
  });

  return hashedPassphrase.toString();
}

function generateRandomSalt() {
  return CryptoJS.lib.WordArray.random(128 / 8).toString();
}

/**
 * Check if a particular option has been set by the user. Useful for distinguishing default value with flag without
 * parameter.
 *
 * Ex use case: '-s' means "give me a salt", '-s 1234' means "use 1234 as salt"
 *
 * From https://github.com/yargs/yargs/issues/513#issuecomment-221412008
 *
 * @param option
 * @param yargs
 * @returns {boolean}
 */
function isOptionSetByUser(option, yargs) {
  function searchForOption(option) {
    return process.argv.indexOf(option) > -1;
  }

  if (searchForOption(`-${option}`) || searchForOption(`--${option}`)) {
    return true;
  }

  // Handle aliases for same option
  for (let aliasIndex in yargs.parsed.aliases[option]) {
    const alias = yargs.parsed.aliases[option][aliasIndex];

    if (searchForOption(`-${alias}`) || searchForOption(`--${alias}`))
      return true;
  }

  return false;
}

const yargs = Yargs.usage("Usage: staticrypt <filename> <passphrase> [options]")
  .option("c", {
    alias: "config",
    type: "string",
    describe: 'Path to the config file. Set to "false" to disable.',
    default: ".staticrypt.json",
  })
  .option("decrypt-button", {
    type: "string",
    describe: 'Label to use for the decrypt button. Default: "DECRYPT".',
    default: "DECRYPT",
  })
  .option("e", {
    alias: "embed",
    type: "boolean",
    describe:
      "Whether or not to embed crypto-js in the page (or use an external CDN).",
    default: true,
  })
  .option("f", {
    alias: "file-template",
    type: "string",
    describe: "Path to custom HTML template with passphrase prompt.",
    default: path.join(__dirname, "password_template.html"),
  })
  .option("i", {
    alias: "instructions",
    type: "string",
    describe: "Special instructions to display to the user.",
    default: "",
  })
  .option("noremember", {
    type: "boolean",
    describe: 'Set this flag to remove the "Remember me" checkbox.',
    default: false,
  })
  .option("o", {
    alias: "output",
    type: "string",
    describe: "File name / path for generated encrypted file.",
    default: null,
  })
  .option("passphrase-placeholder", {
    type: "string",
    describe: "Placeholder to use for the passphrase input.",
    default: "Passphrase",
  })
  .option("r", {
    alias: "remember",
    type: "number",
    describe:
      'Expiration in days of the "Remember me" checkbox that will save the (salted + hashed) passphrase ' +
      'in localStorage when entered by the user. Default: "0", no expiration.',
    default: 0,
  })
  .option("remember-label", {
    type: "string",
    describe: 'Label to use for the "Remember me" checkbox.',
    default: "Remember me",
  })
  // do not give a default option to this 'remember' parameter - we want to see when the flag is included with no
  // value and when it's not included at all
  .option("s", {
    alias: "salt",
    describe:
      'Set the salt manually. It should be set if you want use "Remember me" through multiple pages. It ' +
      "needs to be a 32 character long hexadecimal string.\nInclude the empty flag to generate a random salt you " +
      'can use: "statycrypt -s".',
    type: "string",
  })
  .option("t", {
    alias: "title",
    type: "string",
    describe: "Title for output HTML page.",
    default: "Protected Page",
  });
const namedArgs = yargs.argv;

// if the 's' flag is passed without parameter, generate a salt, display & exit
if (isOptionSetByUser("s", yargs) && !namedArgs.salt) {
  console.log(generateRandomSalt());
  process.exit(0);
}

// validate the number of arguments
if (namedArgs._.length !== 2) {
  Yargs.showHelp();
  process.exit(1);
}

// get config file
const isUsingconfigFile = namedArgs.config.toLowerCase() !== "false";
const configPath = "./" + namedArgs.config;
let config = {};
if (isUsingconfigFile && fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
}

/**
 * Get the salt to use
 */
let salt;
// either a salt was provided by the user through the flag --salt
if (!!namedArgs.salt) {
  salt = String(namedArgs.salt).toLowerCase();
}
// or we try to read the salt from config file
else if (!!config.salt) {
  salt = config.salt;
}
// or we generate a salt
else {
  salt = generateRandomSalt();
}

// validate the salt
if (salt.length !== 32 || /[^a-f0-9]/.test(salt)) {
  console.log(
    "The salt should be a 32 character long hexadecimal string (only [0-9a-f] characters allowed)"
  );
  console.log("Detected salt: " + salt);
  process.exit(1);
}

// write salt to config file
if (isUsingconfigFile && config.salt !== salt) {
  config.salt = salt;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
}

// parse input
const input = namedArgs._[0].toString(),
  passphrase = namedArgs._[1].toString();

// get the file content
let contents;
try {
  contents = fs.readFileSync(input, "utf8");
} catch (e) {
  console.log("Failure: input file does not exist!");
  process.exit(1);
}

// encrypt input
const hashedPassphrase = hashPassphrase(passphrase, salt);
const encrypted = encrypt(contents, hashedPassphrase);
// we use the hashed passphrase in the HMAC because this is effectively what will be used a passphrase (so we can store
// it in localStorage safely, we don't use the clear text passphrase)
// const hmac = CryptoJS.HmacSHA256(encrypted, CryptoJS.SHA256(hashedPassphrase).toString()).toString();
// const encryptedMessage = hmac + encrypted;

// TODO(aph) - Merge this data with the literal in ecrypt below
const data = {
  decrypt_button: namedArgs.decryptButton,
  embed: namedArgs.embed,
  encrypted: encryptedMessage,
  instructions: namedArgs.instructions,
  is_remember_enabled: namedArgs.noremember ? "false" : "true",
  output_file_path:
    namedArgs.output !== null
      ? namedArgs.output
      : input.replace(/\.html$/, "") + "_encrypted.html",
  passphrase_placeholder: namedArgs.passphrasePlaceholder,
  remember_duration_in_days: namedArgs.remember,
  remember_me: namedArgs.rememberLabel,
  salt: salt,
  title: namedArgs.title,
};

// genFile(data);

function encrypt(msg, password) {
  var iv = getRandomValues(new Uint8Array(16));
  var ivHex = bytesToHexString(iv);
  var pwUtf8 = stringToUint8Array(password);

  subtle
    .digest("SHA-256", pwUtf8)
    .then(function (hash) {
      return bytesToHexString(hash);
    })
    .then(function (pwHex) {
      return hexStringToUint8Array(pwHex);
    })
    .then(function (keyData) {
      return subtle.importKey("raw", keyData, "AES-GCM", false, ["encrypt"]);
    })
    .then(function (key) {
      return subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv,
        },
        key,
        stringToUint8Array(msg)
      );
    })
    .then(function (cipherText) {
      return ivHex + bytesToHexString(cipherText);
    })
    .then(function (encrypted) {
      return {
        title: namedArgs.title,
        instructions: namedArgs.instructions,
        encrypted: encrypted,
        outputFilePath:
          namedArgs.output !== null
            ? namedArgs.output
            : input.replace(/\.html$/, "") + "_encrypted.html",
      };
    })
    .then(function (data) {
      genFile(data);
    })
    .catch(console.log);
}

encrypt(contents, password);

/**
 * Fill the template with provided data and writes it to output file.
 *
 * @param data
 */
function genFile(data) {
  let templateContents;

  try {
    templateContents = fs.readFileSync(namedArgs.f, "utf8");
  } catch (e) {
    console.log("Failure: could not read template!");
    process.exit(1);
  }

  const renderedTemplate = render(templateContents, data);

  try {
    fs.writeFileSync(data.output_file_path, renderedTemplate);
  } catch (e) {
    console.log("Failure: could not generate output file!");
    process.exit(1);
  }
}

/**
 * Replace the placeholder tags (between '{tag}') in 'tpl' string with provided data.
 *
 * @param tpl
 * @param data
 * @returns string
 */
function render(tpl, data) {
  return tpl.replace(/{(.*?)}/g, function (_, key) {
    if (data && data[key] !== undefined) {
      return data[key];
    }

    return "";
  });
}

/*
 * encode/decode funtions
 */

function hexStringToUint8Array(hexString) {
  if (hexString.length % 2 != 0) throw "Invalid hexString";
  var arrayBuffer = new Uint8Array(hexString.length / 2);

  for (var i = 0; i < hexString.length; i += 2) {
    var byteValue = parseInt(hexString.substr(i, 2), 16);
    if (byteValue == NaN) throw "Invalid hexString";
    arrayBuffer[i / 2] = byteValue;
  }

  return arrayBuffer;
}

function bytesToHexString(bytes) {
  if (!bytes) return null;

  bytes = new Uint8Array(bytes);
  var hexBytes = [];

  for (var i = 0; i < bytes.length; ++i) {
    var byteString = bytes[i].toString(16);
    if (byteString.length < 2) byteString = "0" + byteString;
    hexBytes.push(byteString);
  }
  return hexBytes.join("");
}

function stringToUint8Array(str) {
  var encoder = new TextEncoder("utf-8");
  return encoder.encode(str);
}
