import * as path from "path";
import {spawn} from 'child_process';

const HIVES_SHORT 	= ['HKLM', 'HKU', 'HKCU', 'HKCR', 'HKCC'];
const HIVES_LONG	= ['HKEY_LOCAL_MACHINE', 'HKEY_USERS', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_CURRENT_CONFIG'];
const KEY_PATTERN   = /(\\[a-zA-Z0-9_\s]+)*/;
const PATH_PATTERN	= /^(HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKEY_CLASSES_ROOT|HKEY_USERS|HKEY_CURRENT_CONFIG).*\\(.*)$/;
const ITEM_PATTERN  = /^(.*)\s(REG_SZ|REG_MULTI_SZ|REG_EXPAND_SZ|REG_DWORD|REG_QWORD|REG_BINARY|REG_NONE)\s+([^\s].*)$/;

const hosts32 : Record<string, KeyImp> = {};
const hosts64 : Record<string, KeyImp> = {};

export const HIVES			= HIVES_LONG;
export const REMOTE_HIVES	= HIVES.slice(0, 2);

export interface Type {
	name:	string;
	parse:	(s:string)=>Data;
}

export interface Data {
	raw:	Uint8Array;
	value:	any;
	constructor: {name:string};
}

function hex_to_bytes(s: string) {
	return new Uint8Array(Array.from({length: Math.ceil(s.length / 2)}, (_, i) => s.slice(i * 2, (i + 1) * 2)).map(i => parseInt(i, 16)));
}
function bytes_to_hex(value: Uint8Array) {
	return `${Array.from(value).map(i => i.toString(16).padStart(2, '0')).join(',')}`;
}
function string_to_bytes(buffer:ArrayBuffer, offset: number, value: string) {
	const a = new DataView(buffer, offset);
	for (let i = 0; i < value.length; i++)
		a.setUint16(i * 2, value.charCodeAt(i), true);
	a.setUint16(value.length * 2, 0, true);
	return offset + (value.length + 1) * 2;
}

function bytes_to_string(buffer: ArrayBuffer) {
	const s = new TextDecoder('utf-16le').decode(buffer);
	return s.endsWith('\0') ? s.slice(0, -1) : s;
}

class NONE implements Data {
	static parse(s:string) { return new NONE(hex_to_bytes(s)); }
	constructor(public value: Uint8Array) {}
	get raw() { return this.value; }
}

class BINARY extends NONE {
	static parse(s:string) { return new BINARY(hex_to_bytes(s)); }
}
class LINK extends NONE {
	static parse(s:string) { return new LINK(hex_to_bytes(s)); }
}
class RESOURCE_LIST extends NONE {
	static parse(s:string) { return new RESOURCE_LIST(hex_to_bytes(s)); }
}
class FULL_RESOURCE_DESCRIPTOR extends NONE {
	static parse(s:string) { return new FULL_RESOURCE_DESCRIPTOR(hex_to_bytes(s)); }
}
class RESOURCE_REQUIREMENTS_LIST extends NONE {
	static parse(s:string) { return new RESOURCE_REQUIREMENTS_LIST(hex_to_bytes(s)); }
}
class SZ implements Data {
	static parse(s:string) { return new SZ(s); }
	constructor(public value: string) {}
	get raw() { 
		const length = this.value.length;
		const a = new Uint16Array(length + 1);
		for (let i = 0; i < length; i++)
			a[i] = this.value.charCodeAt(i);
		a[length] = 0;
		return new Uint8Array(a.buffer);
	}
}
class EXPAND_SZ extends SZ {
	static parse(s:string) { return new EXPAND_SZ(s); }
}
class DWORD implements Data {
	static parse(s:string) { return new DWORD(+s); }
	constructor(public value: number) {}
	get raw() { 
		const bytes = new Uint8Array(4);
		new DataView(bytes.buffer).setUint32(0, this.value, true);
		return bytes;
	}	
}
class DWORD_BIG_ENDIAN implements Data {
	static parse(s:string) { return new DWORD_BIG_ENDIAN(+s); }
	constructor(public value: number) {}
	get raw() { 
		const bytes = new Uint8Array(4);
		new DataView(bytes.buffer).setUint32(0, this.value, false);
		return bytes;
	}	
}
class MULTI_SZ implements Data {
	static parse(s:string) { return new MULTI_SZ(s.split('\\0')); }
	constructor(public value: string[]) {}
	get raw() { 
		const length = this.value.reduce((acc, i) => acc + i.length + 1, 0);
		const a = new Uint16Array(length + 1);
		const end = this.value.reduce((acc, i) => {
			for (let j = 0; j < i.length; j++)
				a[acc + j] = i.charCodeAt(j);
			a[acc + i.length] = 0;
			return acc + i.length + 1;
		}, 0);
		return new Uint8Array(a.buffer);
	}

}
class QWORD implements Data {
	static parse(s:string) { return new QWORD(BigInt(s)); }
	constructor(public value: bigint) {}
	get raw() { 
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setBigUint64(0, this.value, true);
		return bytes;
	}	
}

export const TYPES : Record<string, Type> = {
	NONE: NONE,
	SZ: SZ,
	EXPAND_SZ: EXPAND_SZ,
	BINARY: BINARY,
	DWORD: DWORD,
	DWORD_BIG_ENDIAN: DWORD_BIG_ENDIAN,
	LINK: LINK,
	MULTI_SZ: MULTI_SZ,
	RESOURCE_LIST: RESOURCE_LIST,
	FULL_RESOURCE_DESCRIPTOR: FULL_RESOURCE_DESCRIPTOR,
	RESOURCE_REQUIREMENTS_LIST: RESOURCE_REQUIREMENTS_LIST,
	QWORD: QWORD,
};

export function string_to_type(type: string) : Type|undefined {
	return TYPES[type.startsWith('REG_') ? type.substring(4) : type];
}

export function data_to_regstring(value: Data, strict: boolean = false) {
	switch (value.constructor.name) {
		case 'NONE':						return `hex(0):${bytes_to_hex(value.value)}`;
		case 'LINK':						return `hex(6):${bytes_to_hex(value.value)}`;
		case 'RESOURCE_LIST':				return `hex(8):${bytes_to_hex(value.value)}`;
		case 'FULL_RESOURCE_DESCRIPTOR':	return `hex(9):${bytes_to_hex(value.value)}`;
		case 'RESOURCE_REQUIREMENTS_LIST':	return `hex(a):${bytes_to_hex(value.value)}`;
		case 'BINARY':						return `hex:${bytes_to_hex(value.value)}`;

		case 'EXPAND_SZ':
			if (strict) {
				const d: string = value.value;
				const bytes = new Uint8Array((d.length + 1) * 2);
				string_to_bytes(bytes.buffer, 0, d);
				return `hex(2):${bytes_to_hex(bytes)}`;
			}
			//falls through
		case 'SZ':
			return `"${value.value}"`;

		case 'DWORD_BIG_ENDIAN':
			if (strict) {
				const bytes = new Uint8Array(4);
				new DataView(bytes.buffer).setUint32(0, value.value, true);
				return `hex(5): ${bytes_to_hex(bytes)}`;
			}
			//falls through
		case 'DWORD':
			return `dword:${value.value.toString(16)}`;

		case 'QWORD':
			if (strict) {
				const bytes = new Uint8Array(8);
				new DataView(bytes.buffer).setBigUint64(0, value.value, true);
				return `hex(11):${bytes_to_hex(bytes)}`;
			}
			return `qword:${value.value.toString(16)}`;

		case 'MULTI_SZ': {
			const d: string[] = value.value;
			if (strict) {
				const length 	= d.reduce((acc, i) => acc + i.length + 1, 1);
				const bytes		= new Uint8Array(length * 2);
				const end 		= d.reduce((acc, i) => string_to_bytes(bytes.buffer, acc, i), 0);
				bytes[end]		= 0;
				bytes[end + 1]	= 0;
				return `hex(7):${bytes_to_hex(bytes)}`;
			}
			return `[${d.map(i => `"${i}"`).join(',')}]`;
		}
		default:
			return '?';
	}
}

export function regstring_to_data(value: string) : Data|undefined {
	const re = /"(.*)"|(dword):([0-9a-fA-F]{8})|hex(\([0-0a-fA-F]+\))?:((?:[0-9a-fA-F]{2},)*[0-9a-fA-F]{2})/;
	const m = re.exec(value);
	if (m) {
		if (m[1])
			return new SZ(m[1]);

		if (m[2])
			return new DWORD(parseInt(m[3], 16));

		const data = new Uint8Array(m[5].split(',').map(v => parseInt(v, 16)));
		if (!m[4])
			return new BINARY(data);

		const dv = new DataView(data.buffer, 0);
		switch (parseInt(m[4], 16)) {
			case 0:		return new NONE(data);
			case 1:		return new SZ(bytes_to_string(data.buffer));
			case 2:		return new EXPAND_SZ(bytes_to_string(data.buffer));
			case 3:		return new BINARY(data);
			case 4:		return new DWORD(dv.getUint32(0, true));
			case 5:		return new DWORD_BIG_ENDIAN(dv.getUint32(0, false));
			case 6:		return new LINK(data);
			case 7:		return new MULTI_SZ(bytes_to_string(data.buffer).split('\0'));
			case 8:		return new RESOURCE_LIST(data);
			case 9:		return new FULL_RESOURCE_DESCRIPTOR(data);
			case 10:	return new RESOURCE_REQUIREMENTS_LIST(data);
			case 11:	return new QWORD(dv.getBigUint64(0, true));
			default:	return new NONE(data);
		}
	}
}

class RegError {
	constructor(public message: string, public code: number = -1) {}
	toString() { return this.message; }
}

class Process {
	stdout: string = '';
	stderr: string = '';
	error?: Error;

	constructor(exec: string, args:string[], reject: (reason?: RegError) => void, close: (proc: Process) => void) {
		//console.log(`SPAWN: ${exec} ${args.join(' ')}`);

		const proc = spawn(exec, args, {
			cwd: undefined,
			env: process.env,
			shell: true,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		proc.stdout.on('data', (data : any) => { this.stdout += data.toString(); });
		proc.stderr.on('data', (data : any) => { this.stderr += data.toString(); });
		proc.on('error', (error: Error) => { this.error = error; });
		proc.on('close', code => {
			if (this.error) {
				reject(new RegError(this.error.message));
			} else if (code) {
				const message =`${exec} ${args.join(' ')} command exited with code ${code}:\n${this.stdout.trim()}\n${this.stderr.trim()}`;
				//console.log(message);
				reject(new RegError(message, code));
			} else {
				close(this);
			}
		});
	}
}

function regExec() {
	return process.platform === 'win32' ? path.join(process.env.windir || '', 'system32', 'reg.exe') : "REG";
}

function argName(name?:string) {
	return name ? ['/v', name] : ['/ve'];
}

function argData(value:Data) {
	const type = value.constructor;
	return ['/t', `REG_${type.name}`, ...(type == MULTI_SZ ? ['/s', ','] : []), '/d', `"${value.value}"`];
}

class KeyImp {
	public _items?: Promise<Record<string, Data>>;
	public _keys: 	Record<string, KeyImp> = {};
	public found?:	boolean;

	private getRootAndPath(): [KeyImp, string] {
		let key = this.name;
		let p 	= this.parent;
		if (!p)
			return [this, key];

		while (p.parent) {
			key = p.name + '\\' + key;
			p 	= p.parent;
		}
		if (p.name)
			key = `\\\\${p.name}\\${key}`;
		return [p, key];
	}
	
	public getView(root?:KeyImp) {
		if (!root)
			root = this.getRootAndPath()[0];
		return hosts32[root.name] === root ? '32' : '64';
	}
	public get path() {
		return this.getRootAndPath()[1];
	}

	private runCommand(command:string, ...args:string[]) {
		const [root, fullpath] = this.getRootAndPath();
		const view = hosts32[root.name] === root ? '32' : '64';
		if (view)
			args.push('/reg:' + view);

		return new Promise<Process>((resolve, reject) => new Process(regExec(), [command, `"${fullpath}"`, ...args], reject, resolve));
	}

	private add_found_key(key:string) {
		if (key && key !== this.name) {
			if (!(key in this._keys))
				this._keys[key] = new KeyImp(key, this);
			this._keys[key].found = true;
		}
	}

	public reread() : Promise<Record<string, any>> {
		return this._items = this.runCommand('QUERY').then(proc => {
			const items : Record<string, Data> = {};
			let lineNumber = 0;
			for (const i of proc.stdout.split('\n')) {
				const line = i.trim();
				if (line.length > 0) {
					if (lineNumber++ !== 0) {
						const match = ITEM_PATTERN.exec(line);
						if (match) {
							const type = string_to_type(match[2].trim());
							if (type)
								items[match[1].trim()] = type.parse(match[3]);
							continue;
						}
					}

					const match = PATH_PATTERN.exec(line);
					if (match)
						this.add_found_key(match[2]);
				}
			}
			for (let p : KeyImp = this; !p.found && p.parent; p = p.parent)
				p.found = true;
			return items;
		});
	}

	public read() : Promise<Record<string, any>> {
		return this._items ?? this.reread();
	}

	constructor(public name: string, public parent?: KeyImp) {}

	public toString() {
		return this.path;
	}

	public subkey(key: string) : KeyImp {
		let p: KeyImp = this;
		for (const i of key.split('\\')) {
			if (!p._keys[i])
				p._keys[i] = new KeyImp(i, p);
			p = p._keys[i];
		}
		return p;
	}

	public async exists() : Promise<boolean> {
		return this.found || (!this.parent?.found && await this.read().then(() => true, () => false));
	}

	public async clear() : Promise<boolean> {
		if (this._items) {
			this._items.then(x => {
				for (const i in x)
					delete x[i];
			});
		}
		return this.runCommand('DELETE', '/f', '/va').then(() => true, () => false);
	}

	public async destroy() : Promise<boolean> {
		return this.runCommand('DELETE', '/f').then(
			() => { delete this.parent?._keys[this.name]; return true; },
			() => false
		);
	}

	public async create() : Promise<Key|undefined> {
		return this.runCommand('ADD', '/f').then(() => MakeKey(this), () => undefined);
	}

	public async deleteValue(key: string) : Promise<boolean> {
		return this.runCommand('DELETE', ...argName(key), '/f').then(
			() => this._items
				? this._items.then(x => { delete x[key]; return true; })
				: true,
			() => false
		);
	}

	public async setValue(key: string, value: Data) : Promise<boolean> {
		return this.runCommand('ADD', ...argName(key), ...argData(value), '/f').then(
			() => this._items
				? this._items.then(x => { x[key] = value; return true; })
				: true,
			() => false
		);
	}

	public async setValueString(key: string, type: Type, value: string) : Promise<boolean> {
		return this.setValue(key, type.parse(value));
	}

	public async export(file: string) : Promise<boolean> {
		return this.runCommand('EXPORT', file, '/y').then(() => true, () => false);
	}

	*[Symbol.iterator]() {
		for (const k in this._keys)
			yield MakeKey(this._keys[k]);
	}
}

interface Values {
	[key:string]:any;
	clear: ()=>void;
	then: (func: (x: Record<string, any>)=>void)=>unknown;
}

interface KeyBase {
	name:		string;
	parent:		KeyImp;
	path:		string;
	exists:		() => Promise<boolean>;
	clear:		() => Promise<boolean>;
	destroy:	() => Promise<boolean>;
	create:		() => Promise<Key|undefined>;
	deleteValue:(key: string) 				=> Promise<boolean>;
	setValue:	(key: string, value: any)	=> Promise<boolean>;
	export:		(file: string) 				=> Promise<boolean>;
	toString:	() => string;
	values: 	Values;
}

export interface Key extends KeyBase {
	[key:string|symbol]:any;
	[Symbol.iterator]: () => any;
}

function MakeValues(p: KeyImp) : Values {
	return new Proxy(p as unknown as Values, {
		get: (obj, key: string) => {
			if (key == 'then')
				return p.read().then.bind(p._items);
			return p.read().then(x => x[key]);
		},
		set: (obj, key:string, value) => {
			p.setValue(key, value);
			return true;
		},
		deleteProperty: (obj, key: string) => {
			p.deleteValue(key);
			return true;
		}
	});
}

function MakeKey(p: KeyImp): Key {
	return new Proxy(p as unknown as Key, {
		get: (obj, key: string | symbol) => {
			const v = p[key as keyof KeyImp];
			if (v)
				return typeof v === 'function' ? v.bind(p) : v;
	
			if (typeof key === 'string') {
				switch (key) {
					case 'values':
						return MakeValues(p);
					case 'then': {
						const a = p.read().then(() => p);
						return a.then.bind(a);
					}
					default:
						return MakeKey(p.subkey(key));
				}
			}
		},
		has: (obj, key: string) => {
			return key in p._keys;
		},
		deleteProperty: (obj, key: string) => {
			p.subkey(key).destroy();
			return true;
		},
	});
}

export function getRawKey(key:string, view?:string) : KeyImp {
	let host = '';
	if (key.startsWith('\\\\')) {
		const i = key.indexOf('\\', 2);
		host	= key.substring(2, i);
		key		= key.substring(i + 1);
	}
	
	let i = key.indexOf('\\');
	if (i === -1)
		i = key.length;

	let hive_index = HIVES_LONG.indexOf(key.substring(0, i));
	if (hive_index === -1) {
		hive_index = HIVES_SHORT.indexOf(key.substring(0, i));
		if (hive_index === -1)
			throw new Error('illegal hive specified.');
		key = `${HIVES_LONG[hive_index]}${key.substring(i)}`;
	}

	if (host && hive_index >= 2)
		throw new Error('For remote access the root key must be HKLM or HKU');

	if (!KEY_PATTERN.test(key ?? ''))
		throw new Error('illegal key specified.');

	if (view && view != '32' && view != '64')
		throw new Error('illegal view specified (use 32 or 64)');

	const hosts = view == '32' ? hosts32 : hosts64;
	let p = hosts[host];
	if (!p)
		hosts[host] = p = new KeyImp(host);

	return p.subkey(key);
}

export function getKey(key:string, view?:string): Key {
	return MakeKey(getRawKey(key, view));
}

export async function importreg(file: string, view?: string, dirty?: KeyBase[]) : Promise<boolean> {
	const args = ['IMPORT', file];
	if (view)
		args.push('/reg:' + view);

	return new Promise<Process>((resolve, reject) => new Process(regExec(), args, reject, resolve))
		.then(() => {
			if (dirty) {
				const parents = new Set<KeyImp>();
				for (const i of dirty) {
					const parent = i.parent;
					parents.add(parent);
					delete parent._keys[i.name];
				}
				Promise.all(Array.from(parents).map(p => p.reread())).then(() => true);

			} else {
				const hosts = view === '32' ? hosts32 : hosts64;
				for (const i in hosts)
					delete hosts[i];
			}
			return true;
		},
		() => false
	);
}
