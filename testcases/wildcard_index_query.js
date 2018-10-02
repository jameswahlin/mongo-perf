if ((typeof tests === "undefined" ? "undefined" : typeof(tests)) != "object") {
    tests = [];
}

/**
 * Creates test cases and adds them to the global testing array.
 *
 * @param {Object} options - Options describing the test case.
 * @param {String} options.name - The name of the test case.
 * @param {Object[]} options.ops - The operations to perform in benchRun.
 * @param {function} options.pre - A function that sets up for the test case.
 * @param {String[]} options.tags - Additional tags describing this test.
 */
function addReadTest(options) {
    tests.push({
        name: "Queries.WildcardIndex." + options.name,
        tags: ["wildcard_read", "indexed", ">=4.1.3"].concat(options.tags),
        pre: options.pre,
        ops: options.ops
    });
}

function populateCollection(docGenerator, collection, count) {
    for (var i = 0; i < count; ++i) {
        collection.insert(docGenerator(i));
    }
}

/**
 * Returns a function that generates a document with the fields listed in 'fieldList'. The value for
 * each field is an integer that is unique to a given document. If a field contains a dotted path,
 * it will be expanded to its corresponding object.
 *
 * Examples:
 * Input: fieldList: ["abc", "def"], seed: 1
 * Output: {abc: 1, def: 1}
 *
 * Input: fieldList: ["foo.bar"], seed: 2
 * Output: {foo: {bar: 2}}
 */
function getMultiFieldPathToIntegerDocumentGenerator(fieldList) {
    assert(fieldList.length > 0);
    return function(seed) {
        var doc = {};
        for (var j = 0; j < fieldList.length; ++j) {
            setDottedFieldToValue(doc, fieldList[j], seed);
        }
        return doc;
    };
}

/**
 * Returns a function that generates a document with the fields listed in 'fieldList'. The value for
 * each field is an array of integers, each with a unique set of 'arraySize' numbers.
 *
 * Example:
 * Input: fieldList: ["abc", "def"], arraySize: 4, seed: 0
 * Output: {abc: [-2, -1, 0, 1], def: [-2, -1, 0, 1]}
 */
function getTopLevelArrayMultiFieldDocumentGenerator(fieldList, arraySize) {
    assert(fieldList.length > 0);
    return function(seed) {
        var valueList = [];
        var value = seed - Math.ceil(arraySize / 2);
        for (var j = 0; j < arraySize; ++j) {
            valueList.push(value++);
        }

        var doc = {};
        for (var k = 0; k < fieldList.length; ++k) {
            doc[fieldList[k]] = valueList;
        }
        return doc;
    };
}

/**
 * Returns a function that generates a document with a single 'fieldList' field. The value for each
 * field is an array of integers, each with 'arraySize' numbers.
 *
 * Example:
 * Input: fieldList: ["abc", "def"], arraySize: 3, seed: 3
 * Output: {def: [0,1,2]}
 */
function getTopLevelArraySingleFieldPerDocumentGenerator(fieldList, arraySize) {
    assert(fieldList.length > 0);
    return function(seed) {
        var value = [];
        for (var j = 0; j < arraySize; ++j) {
            value.push(j);
        }

        var doc = {};
        var currentFieldIndex = seed % fieldList.length;
        doc[fieldList[currentFieldIndex]] = value;
        return doc;
    };
}

/**
 * Populates a collection with test data and creates a regular sparse index. This collection is
 * used for comparison testing against the same data set with a $** index.
 */
function getSetupFunctionForTargetedIndex(fieldsToIndex, documentGenerator, documentCount) {
    return function(collection) {
        collection.drop();
        populateCollection(documentGenerator, collection, documentCount);

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
        populateCollection(documentGenerator, collection, documentCount);

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
    addReadTest({
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
    addReadTest({
        name: name,
        tags: ["regression"],
        pre: getSetupFunctionWithWildcardIndex(fieldsToIndex, documentGenerator, documentCount),
        ops: operationList
    });
    addReadTest({
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
    Random.setRandomSeed(11010);

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
    Random.setRandomSeed(11010);

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
      getPointQueryList([fieldList[0]], 10 /* max value */), getTopLevelArraySingleFieldPerDocumentGenerator(fieldList, 10 /*array size */), numDocuments);

//
// Standalone test which performs a point query against a single non-existent field.
//

fieldList = getNFieldNames(1);
makeStandaloneReadTest("PointQueryOnSingleNonExistentField", ["non-existent"],
      getPointQueryList(["non-existent"], numDocuments), getMultiFieldPathToIntegerDocumentGenerator(fieldList), numDocuments);

//
// Point query against a single indexed field.
//

fieldList = getNFieldNames(1);
makeComparisonReadTest("PointQueryOnSingleField", fieldList,
      getPointQueryList(fieldList, numDocuments), getMultiFieldPathToIntegerDocumentGenerator(fieldList), numDocuments);

fieldList = getNFieldNames(10);
makeComparisonReadTest("PointQueryOnMultipleFields",
                       fieldList,
                       getPointQueryList(fieldList, numDocuments),
                       getMultiFieldPathToIntegerDocumentGenerator(fieldList),
                       numDocuments);

fieldList = getNFieldNames(1);
makeComparisonReadTest("PointQueryOnSingleArrayField",
                       fieldList,
                       getPointQueryList(fieldList, numDocuments),
                       getTopLevelArrayMultiFieldDocumentGenerator(fieldList, defaultArraySize),
                       numDocuments);

fieldList = getNFieldNames(10);
makeComparisonReadTest("PointQueryOnMultipleArrayFields",
                       fieldList,
                       getPointQueryList(fieldList, numDocuments),
                       getTopLevelArrayMultiFieldDocumentGenerator(fieldList, defaultArraySize),
                       numDocuments);

//
// Range query.
//

fieldList = getNFieldNames(1);
makeComparisonReadTest("RangeQueryOnSingleField", fieldList,
      getRangeQueryList(fieldList, numDocuments), getMultiFieldPathToIntegerDocumentGenerator(fieldList), numDocuments);

fieldList = getNFieldNames(10);
makeComparisonReadTest("RangeQueryOnMultipleFields",
                       fieldList,
                       getRangeQueryList(fieldList, numDocuments),
                       getMultiFieldPathToIntegerDocumentGenerator(fieldList),
                       numDocuments);

fieldList = getNFieldNames(1);
makeComparisonReadTest("RangeQueryOnSingleArrayField",
                       fieldList,
                       getRangeQueryList(fieldList, numDocuments),
                       getTopLevelArrayMultiFieldDocumentGenerator(fieldList, defaultArraySize),
                       numDocuments);

//
// Range query with indexed sort.
//

fieldList = getNFieldNames(1);
makeComparisonReadTest("RangeSortQueryOnSingleField", fieldList,
      getRangeSortQueryList(fieldList, numDocuments), getMultiFieldPathToIntegerDocumentGenerator(fieldList), numDocuments);

fieldList = getNFieldNames(10);
makeComparisonReadTest("RangeSortQueryOnMultipleFields",
                       fieldList,
                       getRangeSortQueryList(fieldList, numDocuments),
                       getMultiFieldPathToIntegerDocumentGenerator(fieldList),
                       numDocuments);

fieldList = getNFieldNames(1);
makeComparisonReadTest("RangeSortQueryOnSingleArrayField",
                       fieldList,
                       getRangeSortQueryList(fieldList, numDocuments),
                       getTopLevelArrayMultiFieldDocumentGenerator(fieldList, defaultArraySize),
                       numDocuments);

//
// Point query on 2 indexed fields.
//

fieldList = getNFieldNames(2);
makeComparisonReadTest("PointQueryOnTwoFields", fieldList,
      getTwoPointQueryList(fieldList, numDocuments), getMultiFieldPathToIntegerDocumentGenerator(fieldList), numDocuments);

fieldList = getNFieldNames(2);
makeComparisonReadTest("PointQueryOnTwoArrayFields",
                       fieldList,
                       getTwoPointQueryList(fieldList, numDocuments),
                       getTopLevelArrayMultiFieldDocumentGenerator(fieldList, defaultArraySize),
                       numDocuments);
