/* global: console, process, require, Promise */
/**
 * See https://github.com/davarcobani/enketo-express/blob/master/doc/duplicates.md for more information about this tool.
 * 
 * MAKE A BACKUP BEFORE RUNNING THIS SCRIPT TO REMOVE DUPLICATES! 
 */
const config = require( '../app/models/config-model' ).server;
const mainClient = require( 'redis' ).createClient( config.redis.main.port, config.redis.main.host, {
    auth_pass: config.redis.main.password
} );
const cacheClient = require( 'redis' ).createClient( config.redis.cache.port, config.redis.cache.host, {
    auth_pass: config.redis.cache.password
} );
const fs = require( 'fs' );
const path = require( 'path' );
let mode = 'analyze';

process.argv.forEach( val => {
    if ( val === 'remove' ) {
        mode = 'remove';
    }
} );

if ( mode === 'analyze' ) {
    console.log( '\nLooking for duplicates...\n' );

    checkDuplicateEnketoIds()
        .catch( error => {
            console.error( error );
        } )
        .then( () => {
            process.exit( 0 );
        } );
} else if ( mode === 'remove' ) {
    console.log( '\nLooking for duplicates to remove them...\n' );
    removeDuplicateEnketoIds()
        .catch( error => {
            console.error( error );
        } )
        .then( () => {
            process.exit( 0 );
        } );
}

function checkDuplicateEnketoIds() {
    return getDuplicates()
        .then( duplicates => {
            duplicates.forEach( duplicate => {
                console.log( 'Duplicate for %s: %s and %s (registered formID: %s)', duplicate.id, duplicate.key1, duplicate.key2, duplicate.openRosaId );
            } );
            console.log( '\nFound %d duplicates.\n', duplicates.length );
        } );
}

function removeDuplicateEnketoIds() {
    return getDuplicates()
        .then( duplicates => {
            const tasks = [];

            console.log( '\nFound %d duplicate(s).\n', duplicates.length );

            duplicates.forEach( duplicate => {
                const or1 = duplicate.key1.split( ',' )[ 1 ];
                const or2 = duplicate.key2.split( ',' )[ 1 ];

                if ( or1 !== duplicate.openRosaId && or2 === duplicate.openRosaId ) {
                    tasks.push( remove( duplicate.key1, duplicate.id ) );
                } else if ( or1 === duplicate.openRosaId && or2 !== duplicate.openRosaId ) {
                    tasks.push( remove( duplicate.key2, duplicate.id ) );
                }

                removeCache( duplicate.key1 );
                removeCache( duplicate.key2 );
            } );

            return Promise.all( tasks );

        } )
        .then( logs => {
            console.log( '\nRemoved %d duplicate(s).\n', logs.length );
            if ( logs.length === 0 ) {
                return;
            }
            return new Promise( ( resolve, reject ) => {
                const p = path.join( __dirname, `../logs/duplicates-removed-${new Date().toISOString().replace( ':', '.' )}.txt` );
                fs.writeFile( p, logs.join( '\n' ), err => {
                    if ( err ) {
                        reject( err );
                    } else {
                        resolve();
                    }
                } );
            } );
        } );
}

function getDuplicates() {
    return getAllKeys()
        .then( keys => {
            const tasks = [];
            keys.forEach( key => {
                tasks.push( getId( key ) );
            } );

            return Promise.all( tasks );
        } )
        .then( objs => {
            const duplicates = [];
            const ids = [];
            const keys = [];
            const tasks = [];

            objs.forEach( obj => {
                const foundIndex = ids.indexOf( obj.id );
                if ( foundIndex === -1 ) {
                    ids.push( obj.id );
                    keys.push( obj.key );
                } else {
                    duplicates.push( {
                        id: obj.id,
                        key1: keys[ foundIndex ],
                        key2: obj.key
                    } );
                }
            } );

            duplicates.forEach( duplicate => {
                tasks.push( getSurveyOpenRosaId( duplicate ) );
            } );
            return Promise.all( tasks );
        } );
}

function getAllKeys() {
    return new Promise( ( resolve, reject ) => {
        mainClient.keys( 'or:*', ( error, keys ) => {
            if ( error ) {
                reject( error );
            } else {
                resolve( keys );
            }
        } );
    } );
}

function getId( key ) {
    return new Promise( ( resolve, reject ) => {
        mainClient.get( key, ( error, id ) => {
            if ( error ) {
                reject( error );
            } else {
                resolve( {
                    key,
                    id
                } );
            }
        } );
    } );
}

function getSurveyOpenRosaId( duplicate ) {
    return new Promise( ( resolve, reject ) => {
        mainClient.hgetall( `id:${duplicate.id}`, ( error, survey ) => {
            if ( error ) {
                reject( error );
            } else {
                duplicate.openRosaId = survey.openRosaId;
                resolve( duplicate );
            }
        } );
    } );
}

function remove( key, id ) {
    let msg;
    return new Promise( ( resolve, reject ) => {
        // just remove it, the next time the Enketo button is clicked, it will add a completely new entry and generate a new Id.
        mainClient.del( key, err => {
            if ( err ) {
                msg = `Error: could not remove ${key} for id ${id}`;
                console.error( msg );
                reject( new Error( msg ) );
            } else {
                msg = `Removed ${key} for id ${id}`;
                console.log( msg );
                resolve( msg );
            }
        } );
    } );
}

function removeCache( key ) {
    const cacheKey = key.replace( 'or:', 'ca:' );
    console.log( 'Removing cache for ', cacheKey );
    // remove cache entries, and ignore results
    cacheClient.del( cacheKey );
}
