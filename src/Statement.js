import { blank, keys } from './utils/object';
import { sequence } from './utils/promise';
import { getName } from './utils/map-helpers';
import getLocation from './utils/getLocation';
import walk from './ast/walk';
import Scope from './ast/Scope';

const emptyArrayPromise = Promise.resolve([]);

export default class Statement {
	constructor ( node, magicString, module ) {
		this.node = node;
		this.module = module;
		this.magicString = magicString;

		this.scope = new Scope();
		this.defines = blank();
		this.modifies = blank();
		this.dependsOn = blank();

		this.isIncluded = false;

		this.leadingComments = [];
		this.trailingComment = null;
		this.margin = [ 0, 0 ];

		// some facts about this statement...
		this.isImportDeclaration = node.type === 'ImportDeclaration';
		this.isExportDeclaration = /^Export/.test( node.type );
	}

	analyse () {
		if ( this.isImportDeclaration ) return; // nothing to analyse

		const statement = this; // TODO use arrow functions instead
		const magicString = this.magicString;

		let scope = this.scope;

		walk( this.node, {
			enter ( node ) {
				let newScope;

				magicString.addSourcemapLocation( node.start );

				switch ( node.type ) {
					case 'FunctionExpression':
					case 'FunctionDeclaration':
					case 'ArrowFunctionExpression':
						if ( node.type === 'FunctionDeclaration' ) {
							scope.addDeclaration( node.id.name, node );
						}

						newScope = new Scope({
							parent: scope,
							params: node.params, // TODO rest params?
							block: false
						});

						// named function expressions - the name is considered
						// part of the function's scope
						if ( node.type === 'FunctionExpression' && node.id ) {
							newScope.addDeclaration( node.id.name, node );
						}

						break;

					case 'BlockStatement':
						newScope = new Scope({
							parent: scope,
							block: true
						});

						break;

					case 'CatchClause':
						newScope = new Scope({
							parent: scope,
							params: [ node.param ],
							block: true
						});

						break;

					case 'VariableDeclaration':
						node.declarations.forEach( declarator => {
							scope.addDeclaration( declarator.id.name, node );
						});
						break;

					case 'ClassDeclaration':
						scope.addDeclaration( node.id.name, node );
						break;
				}

				if ( newScope ) {
					Object.defineProperty( node, '_scope', { value: newScope });
					scope = newScope;
				}
			},
			leave ( node ) {
				if ( node._scope ) {
					scope = scope.parent;
				}
			}
		});

		if ( !this.isImportDeclaration ) {
			walk( this.node, {
				enter: ( node, parent ) => {
					if ( node._scope ) scope = node._scope;

					this.checkForReads( scope, node, parent );
					this.checkForWrites( scope, node );
				},
				leave: ( node ) => {
					if ( node._scope ) scope = scope.parent;
				}
			});
		}

		keys( scope.declarations ).forEach( name => {
			statement.defines[ name ] = true;
		});
	}

	checkForReads ( scope, node, parent ) {
		if ( node.type === 'Identifier' ) {
			// disregard the `bar` in `foo.bar` - these appear as Identifier nodes
			if ( parent.type === 'MemberExpression' && node !== parent.object ) {
				return;
			}

			// disregard the `bar` in { bar: foo }
			if ( parent.type === 'Property' && node !== parent.value ) {
				return;
			}

			const definingScope = scope.findDefiningScope( node.name );

			if ( ( !definingScope || definingScope.depth === 0 ) && !this.defines[ node.name ] ) {
				this.dependsOn[ node.name ] = true;
			}
		}
	}

	checkForWrites ( scope, node ) {
		const addNode = ( node, disallowImportReassignments ) => {
			let depth = 0; // determine whether we're illegally modifying a binding or namespace

			while ( node.type === 'MemberExpression' ) {
				node = node.object;
				depth += 1;
			}

			// disallow assignments/updates to imported bindings and namespaces
			if ( disallowImportReassignments ) {
				const importSpecifier = this.module.imports[ node.name ];

				if ( importSpecifier && !scope.contains( node.name ) ) {
					const minDepth = importSpecifier.name === '*' ?
						2 : // cannot do e.g. `namespace.foo = bar`
						1;  // cannot do e.g. `foo = bar`, but `foo.bar = bar` is fine

					if ( depth < minDepth ) {
						const err = new Error( `Illegal reassignment to import '${node.name}'` );
						err.file = this.module.path;
						err.loc = getLocation( this.module.magicString.toString(), node.start );
						throw err;
					}
				}
			}

			if ( node.type !== 'Identifier' ) {
				return;
			}

			this.modifies[ node.name ] = true;
		};

		if ( node.type === 'AssignmentExpression' ) {
			addNode( node.left, true );
		}

		else if ( node.type === 'UpdateExpression' ) {
			addNode( node.argument, true );
		}

		else if ( node.type === 'CallExpression' ) {
			node.arguments.forEach( arg => addNode( arg, false ) );
		}
	}

	expand () {
		if ( this.isIncluded ) return emptyArrayPromise;
		this.isIncluded = true;

		let result = [];

		// We have a statement, and it hasn't been included yet. First, include
		// the statements it depends on
		const dependencies = Object.keys( this.dependsOn );

		return sequence( dependencies, name => {
			return this.module.define( name ).then( definition => {
				result.push.apply( result, definition );
			});
		})

		// then include the statement itself
			.then( () => {
				result.push( this );
			})

		// then include any statements that could modify the
		// thing(s) this statement defines
			.then( () => {
				return sequence( keys( this.defines ), name => {
					const modifications = this.module.modifications[ name ];

					if ( modifications ) {
						return sequence( modifications, statement => {
							if ( !statement.isIncluded ) {
								return statement.expand()
									.then( statements => {
										result.push.apply( result, statements );
									});
							}
						});
					}
				});
			})

		// the `result` is an array of statements needed to define `name`
			.then( () => {
				return result;
			});
	}

	replaceIdentifiers ( names, bundleExports ) {
		const module = this.module;

		const magicString = this.magicString.clone();
		const replacementStack = [ names ];
		const nameList = keys( names );

		let deshadowList = [];
		nameList.forEach( name => {
			const replacement = names[ name ];
			deshadowList.push( replacement.split( '.' )[0] );
		});

		if ( nameList.length > 0 || keys( bundleExports ).length ) {
			let topLevel = true;

			walk( this.node, {
				enter ( node, parent ) {
					if ( node._skip ) return this.skip();

					// special case - variable declarations that need to be rewritten
					// as bundle exports
					if ( topLevel ) {
						if ( node.type === 'VariableDeclaration' ) {
							// if this contains a single declarator, and it's one that
							// needs to be rewritten, we replace the whole lot
							const name = node.declarations[0].id.name;
							if ( node.declarations.length === 1 && bundleExports[ name ] ) {
								magicString.overwrite( node.start, node.declarations[0].id.end, bundleExports[ name ] );
								node.declarations[0].id._skip = true;
							}

							// otherwise, we insert the `exports.foo = foo` after the declaration
							else {
								const exportInitialisers = node.declarations
									.map( declarator => declarator.id.name )
									.filter( name => !!bundleExports[ name ] )
									.map( name => `\n${bundleExports[name]} = ${name};` )
									.join( '' );

								// TODO clean this up
								try {
									magicString.insert( node.end, exportInitialisers );
								} catch ( err ) {
									magicString.append( exportInitialisers );
								}
							}
						}
					}

					const scope = node._scope;

					if ( scope ) {
						topLevel = false;

						let newNames = blank();
						let hasReplacements;

						keys( names ).forEach( key => {
							if ( !scope.declarations[ key ] ) {
								newNames[ key ] = names[ key ];
								hasReplacements = true;
							}
						});

						deshadowList.forEach( name => {
							if ( ~scope.declarations[ name ] ) {
								newNames[ name ] = name + '$$'; // TODO better mechanism
								hasReplacements = true;
							}
						});

						if ( !hasReplacements ) {
							return this.skip();
						}

						names = newNames;
						replacementStack.push( newNames );
					}

					// We want to rewrite identifiers (that aren't property names etc)
					if ( node.type !== 'Identifier' ) return;
					if ( parent.type === 'MemberExpression' && !parent.computed && node !== parent.object ) return;
					if ( parent.type === 'Property' && node !== parent.value ) return;
					// TODO others...?

					const name = names[ node.name ];

					if ( name && name !== node.name ) {
						magicString.overwrite( node.start, node.end, name );
					}
				},

				leave ( node ) {
					if ( node._scope ) {
						replacementStack.pop();
						names = replacementStack[ replacementStack.length - 1 ];
					}
				}
			});
		}

		return magicString;
	}
}
