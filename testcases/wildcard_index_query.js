if ((typeof tests === "undefined" ? "undefined" : typeof(tests)) != "object") {
    tests = [];
}

Random.setRandomSeed(11010);

/**
 * Creates test cases and adds them to the global testing array.
 *
 * @param {Object} options - Options describing the test case.
 * @param {String} options.name - The name of the test case.
 * @param {Object[]} options.ops - The operations to perform in benchRun.
 * @param {function} options.pre - A function that sets up for the test case.
 * @param {String[]} options.tags - Additional tags describing this test.
 */
function addTest(options) {
    tests.push({
        name: "Queries.WildcardIndex." + options.name,
        tags: ["wildcard", "query", "indexed", /*">=4.1.3"*/].concat(options.tags),
        pre: options.pre,
        ops: options.ops
    });
}

function getNFieldNames(numFields) {
    var fieldNames = [];
    for (var i = 0; i < numFields; i++) {
        fieldNames.push("field-" + i);
    }
    return fieldNames;
}

/**
 * Returns an array of 'nFields' strings, each containing a unique field name, prefixed by a dotted
 * path of 'depth' length.
 */
function getNFieldNamesAtGivenDepth(nFields, depth) {
    var pathPrefix = "";

    for (var i = 0; i < depth; ++i) {
        if (i > 0) {
            pathPrefix += ".";
        }

        pathPrefix += ("subObj-" + i);
    }

    var fieldNames = getNFieldNames(nFields);
    for (var j = 0; j < fieldNames.length; ++j) {
        fieldNames[j] = pathPrefix + "." + fieldNames[j];
    }

    return fieldNames;
}

/**
 * Inserts value at the location specified by path (using dot notation) in object.
 * If there's a common non-object field name this function overwrites the previous values.
 */
function setDottedFieldToValue(object, path, value) {
    if (typeof path === "string") {
        var fields = path.split(".");
        if (fields.length == 1) {
            object[path] = value;
        } else {
            if (typeof(object[fields[0]]) !== "object") {
                object[fields[0]] = {};
            }
            setDottedFieldToValue(
                object[fields[0]], path.slice(fields[0].length + 1, path.length), value);
        }
    }
    return object;
}

/**
 * Inserts 'documentCount' documents, each with the fields listed in 'fieldList' into the test
 * collection. The value for each field is an integer that is unique to a given document. If a field
 * contains a dotted path, it will be expanded to its corresponding object.
 */
function getDocumentGenerator(fieldList, documentCount) {
    assert(fieldList.length > 0);
    return function(collection) {
        for (var i = 0; i < documentCount; ++i) {
            var doc = {};
            for (var j = 0; j < fieldList.length; ++j) {
                setDottedFieldToValue(doc, fieldList[j], i);
            }
            collection.insert(doc);
        }
    };
}

/**
 * Inserts 'documentCount' documents, each with the fields listed in 'fieldList' into the test
 * collection. The value for each field is an array of integers, each with a unique set of
 * 'arraySize' numbers.
 */
function getTopLevelArrayDocumentGenerator(fieldList, documentCount, arraySize) {
    assert(fieldList.length > 0);
    return function(collection) {
        for (var i = 0; i < documentCount; ++i) {
            var value = [];
            var offset = arraySize * 10 / 2;
            for (var j = i - offset; j < i + offset; j += 10) {
                value.push(j);
            }

            var doc = {};
            for (var k = 0; k < fieldList.length; ++k) {
                doc[fieldList[k]] = value;
            }
            collection.insert(doc);
        }
    };
}

/**
 * Inserts 'documentCount' documents, each with the single 'fieldList' field into the test
 * collection. The value for each field is an array of integers, each with 'arraySize' numbers.
 */
function getTopLevelArraySingleFieldPerDocumentGenerator(fieldList, documentCount, arraySize) {
    assert(fieldList.length > 0);
    return function(collection) {
        var currentFieldIndex = 0;
        for (var i = 0; i < documentCount; ++i) {
            var value = [];
            for (var j = 0; j < arraySize; ++j) {
                value.push(j);
            }

            var doc = {};
            doc[fieldList[currentFieldIndex]] = value;
            collection.insert(doc);
            currentFieldIndex = (currentFieldIndex + 1) % fieldList.length;
        }
    };
}

/**
 * Populates a collection with test data and creates a regular sparse index. This collection is
 * used for comparison testing against the same data set with a $** index.
 */
function getSetupFunctionForTargetedIndex(fieldsToIndex, documentGenerator, documentCount) {
    return function(collection) {
        collection.drop();
        documentGenerator(collection, documentCount);

        for (var i = 0; i < fieldsToIndex.length; ++i) {
            var indexSpec = {};
            indexSpec[fieldsToIndex[i]] = 1;
            assert.commandWorked(collection.createIndex(indexSpec, {sparse: true}));
        }
    };
}

/**
 * Populates a collection with test data and creates a $** index.
 */
function getSetupFunctionWithWildcardIndex(fieldsToIndex, documentGenerator, documentCount) {
    return function(collection) {
        collection.drop();
        documentGenerator(collection, documentCount);

        var proj = {};
        for (var i = 0; i < fieldsToIndex.length; ++i) {
            proj[fieldsToIndex[i]] = 1;
        }
        var indexOptions = undefined;
        if (fieldsToIndex.length > 0) {
            indexOptions = {wildcardProjection: proj};
        }
        assert.commandWorked(collection.createIndex({"$**": 1}, indexOptions));
    };
}

/**
 * Creates a performance test with a $** index.
 */
function makeStandaloneReadTest(
    name, fieldsToIndex, operationList, documentGenerator, documentCount) {
    addTest({
        name: name,
        tags: ["regression"],
        pre: getSetupFunctionWithWildcardIndex(fieldsToIndex, documentGenerator, documentCount),
        ops: operationList
    });
}

/**
 * Creates 2 performance tests, one with a $** index and a second with a regular sparse index for
 * comparison.
 */
function makeComparisonReadTest(
    name, fieldsToIndex, operationList, documentGenerator, documentCount) {
    addTest({
        name: name,
        tags: ["regression"],
        pre: getSetupFunctionWithWildcardIndex(fieldsToIndex, documentGenerator, documentCount),
        ops: operationList
    });
    addTest({
        name: name + ".Baseline",
        tags: ["regression"],
        pre: getSetupFunctionForTargetedIndex(fieldsToIndex, documentGenerator, documentCount),
        ops: operationList
    });
}

/**
 * Returns a list of point query operations, each searching for a random value between 0 and
 * 'maxValue'.
 */
function getPointQueryList(fieldList, maxValue) {
    var list = [];
    for (var i = 0; i < fieldList.length; ++i) {
        var query = {};
        query[fieldList[i]] = {"#RAND_INT": [0, maxValue]};
        list.push({op: "find", query: query});
    }
    return list;
}

/**
 * Returns a list of 2 predicate point query operations, each searching for 2 fields with a random
 * value between 0 and 'maxValue'.
 */
function getTwoPointQueryList(fieldList, numDocuments) {
    assert(fieldList.length === 2);

    var letArg = {op: "let", target: "randVal", value: {"#RAND_INT": [0, numDocuments]}};

    var queryArg1 = {};
    queryArg1[fieldList[0]] = {"#VARIABLE": "randVal"};

    var queryArg2 = {};
    queryArg2[fieldList[1]] = {"#VARIABLE": "randVal"};

    var query = {$and: [queryArg1, queryArg2]};
    return [letArg, {op: "find", query: query}];
}

/**
 * Returns a list of range queries, searching for a 10 document range between 0 and 'numDocuments'.
 */
function getRangeQueryList(fieldList, numDocuments) {
    var list = [];
    for (var i = 0; i < fieldList.length; ++i) {
        var query = {};
        var rangeStart = Random.randInt(numDocuments - 10);

        query[fieldList[i]] = {$gte: rangeStart, $lte: (rangeStart + 10)};
        list.push({op: "find", query: query});
    }
    return list;
}

/**
 * Returns a list of range + sort queries, searching for a 10 document range between 0 and
 * 'numDocuments', performing an indexed sort on the query field.
 */
function getRangeSortQueryList(fieldList, numDocuments) {
    var list = [];
    for (var i = 0; i < fieldList.length; ++i) {
        var query = {};
        var sort = {};
        var rangeStart = Random.randInt(numDocuments - 10);

        query[fieldList[i]] = {$gte: rangeStart, $lte: (rangeStart + 10)};
        sort[fieldList[i]] = 1;
        list.push({op: "find", query: {$query: query, $orderby: sort}});
    }
    return list;
}

var numDocuments = 100;
var defaultArraySize = 100;
var fieldList = [];

//
// Standalone test which perfoms a point query against a single multikey path, in a collection with
// 100 multikey paths.
//

fieldList = getNFieldNames(100);
makeStandaloneReadTest("PointQueryAgainstCollectionWith100MultikeyPaths", fieldList,
      getPointQueryList([fieldList[0]], 10 /* max value */), getTopLevelArraySingleFieldPerDocumentGenerator(fieldList, numDocuments, 10 /*array size */));

//
// Point query against a single indexed field.
//

fieldList = getNFieldNames(1);
makeComparisonReadTest("PointQueryOnSingleField", fieldList,
      getPointQueryList(fieldList, numDocuments), getDocumentGenerator(fieldList, numDocuments));

fieldList = getNFieldNames(10);
makeComparisonReadTest("PointQueryOnMultipleFields",
                       fieldList,
                       getPointQueryList(fieldList, numDocuments),
                       getDocumentGenerator(fieldList, numDocuments));

fieldList = getNFieldNames(1);
makeComparisonReadTest(
    "PointQueryOnSingleArrayField",
    fieldList,
    getPointQueryList(fieldList, numDocuments),
    getTopLevelArrayDocumentGenerator(fieldList, numDocuments, defaultArraySize));

fieldList = getNFieldNames(10);
makeComparisonReadTest(
    "PointQueryOnMultipleArrayFields",
    fieldList,
    getPointQueryList(fieldList, numDocuments),
    getTopLevelArrayDocumentGenerator(fieldList, numDocuments, defaultArraySize));

fieldList = getNFieldNamesAtGivenDepth(1, 10);
makeComparisonReadTest("PointQueryOnSingleDeeplyNestedField",
                       fieldList,
                       getPointQueryList(fieldList, numDocuments),
                       getDocumentGenerator(fieldList, numDocuments));

fieldList = getNFieldNamesAtGivenDepth(10, 10);
makeComparisonReadTest("PointQueryOnMultipleDeeplyNestedFields",
                       fieldList,
                       getPointQueryList(fieldList, numDocuments),
                       getDocumentGenerator(fieldList, numDocuments));

//
// Range query against a single field.
//

fieldList = getNFieldNames(1);
makeComparisonReadTest("RangeQueryOnSingleField", fieldList,
      getRangeQueryList(fieldList, numDocuments), getDocumentGenerator(fieldList, numDocuments));

fieldList = getNFieldNames(10);
makeComparisonReadTest("RangeQueryOnMultipleFields",
                       fieldList,
                       getRangeQueryList(fieldList, numDocuments),
                       getDocumentGenerator(fieldList, numDocuments));

fieldList = getNFieldNames(1);
makeComparisonReadTest(
    "RangeQueryOnSingleArrayField",
    fieldList,
    getRangeQueryList(fieldList, numDocuments),
    getTopLevelArrayDocumentGenerator(fieldList, numDocuments, defaultArraySize));

fieldList = getNFieldNames(10);
makeComparisonReadTest(
    "RangeQueryOnMultipleArrayFields",
    fieldList,
    getRangeQueryList(fieldList, numDocuments),
    getTopLevelArrayDocumentGenerator(fieldList, numDocuments, defaultArraySize));

fieldList = getNFieldNamesAtGivenDepth(1, 10);
makeComparisonReadTest("RangeQueryOnSingleDeeplyNestedField",
                       fieldList,
                       getRangeQueryList(fieldList, numDocuments),
                       getDocumentGenerator(fieldList, numDocuments));

fieldList = getNFieldNamesAtGivenDepth(10, 10);
makeComparisonReadTest("RangeQueryOnMultipleDeeplyNestedFields",
                       fieldList,
                       getRangeQueryList(fieldList, numDocuments),
                       getDocumentGenerator(fieldList, numDocuments));

//
// Range query against a single field with indexed sort.
//

fieldList = getNFieldNames(1);
makeComparisonReadTest("RangeSortQueryOnSingleField", fieldList,
      getRangeSortQueryList(fieldList, numDocuments), getDocumentGenerator(fieldList, numDocuments));

fieldList = getNFieldNames(10);
makeComparisonReadTest("RangeSortQueryOnMultipleFields",
                       fieldList,
                       getRangeSortQueryList(fieldList, numDocuments),
                       getDocumentGenerator(fieldList, numDocuments));

fieldList = getNFieldNames(1);
makeComparisonReadTest(
    "RangeSortQueryOnSingleArrayField",
    fieldList,
    getRangeSortQueryList(fieldList, numDocuments),
    getTopLevelArrayDocumentGenerator(fieldList, numDocuments, defaultArraySize));

fieldList = getNFieldNames(10);
makeComparisonReadTest(
    "RangeSortQueryOnMultipleArrayFields",
    fieldList,
    getRangeSortQueryList(fieldList, numDocuments),
    getTopLevelArrayDocumentGenerator(fieldList, numDocuments, defaultArraySize));

fieldList = getNFieldNamesAtGivenDepth(1, 10);
makeComparisonReadTest("RangeSortQueryOnSingleDeeplyNestedField",
                       fieldList,
                       getRangeSortQueryList(fieldList, numDocuments),
                       getDocumentGenerator(fieldList, numDocuments));

fieldList = getNFieldNamesAtGivenDepth(10, 10);
makeComparisonReadTest("RangeSortQueryOnMultipleDeeplyNestedFields",
                       fieldList,
                       getRangeSortQueryList(fieldList, numDocuments),
                       getDocumentGenerator(fieldList, numDocuments));

//
// Point query on 2 indexed fields.
//

fieldList = getNFieldNames(2);
makeComparisonReadTest("PointQueryOnTwoFields", fieldList,
      getTwoPointQueryList(fieldList, numDocuments), getDocumentGenerator(fieldList, numDocuments));

fieldList = getNFieldNames(2);
makeComparisonReadTest(
    "PointQueryOnTwoArrayFields",
    fieldList,
    getTwoPointQueryList(fieldList, numDocuments),
    getTopLevelArrayDocumentGenerator(fieldList, numDocuments, defaultArraySize));

fieldList = getNFieldNamesAtGivenDepth(2, 10);
makeComparisonReadTest("PointQueryOnTwoDeeplyNestedFields",
                       fieldList,
                       getTwoPointQueryList(fieldList, numDocuments),
                       getDocumentGenerator(fieldList, numDocuments));

//
// Point query against a single non-existent field.
//

fieldList = getNFieldNames(1);
makeComparisonReadTest("PointQueryOnSingleNonExistentField", ["non-existent"],
      getPointQueryList(["non-existent"], numDocuments), getDocumentGenerator(fieldList, numDocuments));
