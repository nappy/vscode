/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IProductService } from 'vs/platform/product/common/productService';
import { IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IAuthenticationService } from 'vs/workbench/services/authentication/browser/authenticationService';
import { IFileService } from 'vs/platform/files/common/files';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';

const TRUSTED_DOMAINS_URI = URI.parse('trustedDomains:/Trusted Domains');

export const TRUSTED_DOMAINS_STORAGE_KEY = 'http.linkProtectionTrustedDomains';
export const TRUSTED_DOMAINS_CONTENT_STORAGE_KEY = 'http.linkProtectionTrustedDomainsContent';

export const manageTrustedDomainSettingsCommand = {
	id: 'workbench.action.manageTrustedDomain',
	description: {
		description: localize('trustedDomain.manageTrustedDomain', 'Manage Trusted Domains'),
		args: []
	},
	handler: async (accessor: ServicesAccessor) => {
		const editorService = accessor.get(IEditorService);
		editorService.openEditor({ resource: TRUSTED_DOMAINS_URI, mode: 'jsonc' });
		return;
	}
};

type ConfigureTrustedDomainChoice = 'trustDomain' | 'trustSubdomain' | 'trustAll' | 'manage';
interface ConfigureTrustedDomainsQuickPickItem extends IQuickPickItem {
	id: ConfigureTrustedDomainChoice;
}
type ConfigureTrustedDomainsChoiceClassification = {
	choice: { classification: 'SystemMetaData', purpose: 'FeatureInsight' };
};

export async function configureOpenerTrustedDomainsHandler(
	trustedDomains: string[],
	domainToConfigure: string,
	quickInputService: IQuickInputService,
	storageService: IStorageService,
	editorService: IEditorService,
	telemetryService: ITelemetryService
) {
	const parsedDomainToConfigure = URI.parse(domainToConfigure);
	const toplevelDomainSegements = parsedDomainToConfigure.authority.split('.');
	const domainEnd = toplevelDomainSegements.slice(toplevelDomainSegements.length - 2).join('.');
	const topLevelDomain = '*.' + domainEnd;

	const trustDomainAndOpenLinkItem: ConfigureTrustedDomainsQuickPickItem = {
		type: 'item',
		label: localize('trustedDomain.trustDomain', 'Trust {0}', domainToConfigure),
		id: 'trustDomain',
		picked: true
	};
	const trustSubDomainAndOpenLinkItem: ConfigureTrustedDomainsQuickPickItem = {
		type: 'item',
		label: localize('trustedDomain.trustSubDomain', 'Trust {0} and all its subdomains', domainEnd),
		id: 'trustSubdomain'
	};
	const openAllLinksItem: ConfigureTrustedDomainsQuickPickItem = {
		type: 'item',
		label: localize('trustedDomain.trustAllDomains', 'Trust all domains (disables link protection)'),
		id: 'trustAll'
	};
	const manageTrustedDomainItem: ConfigureTrustedDomainsQuickPickItem = {
		type: 'item',
		label: localize('trustedDomain.manageTrustedDomains', 'Manage Trusted Domains'),
		id: 'manage'
	};

	const pickedResult = await quickInputService.pick<ConfigureTrustedDomainsQuickPickItem>(
		[trustDomainAndOpenLinkItem, trustSubDomainAndOpenLinkItem, openAllLinksItem, manageTrustedDomainItem],
		{
			activeItem: trustDomainAndOpenLinkItem
		}
	);

	if (pickedResult && pickedResult.id) {
		telemetryService.publicLog2<{ choice: string }, ConfigureTrustedDomainsChoiceClassification>(
			'trustedDomains.configureTrustedDomainsQuickPickChoice',
			{ choice: pickedResult.id }
		);

		switch (pickedResult.id) {
			case 'manage':
				editorService.openEditor({
					resource: TRUSTED_DOMAINS_URI,
					mode: 'jsonc'
				});
				return trustedDomains;
			case 'trustDomain':
			case 'trustSubdomain':
			case 'trustAll':
				const itemToTrust = pickedResult.id === 'trustDomain'
					? domainToConfigure
					: pickedResult.id === 'trustSubdomain' ? topLevelDomain : '*';

				if (trustedDomains.indexOf(itemToTrust) === -1) {
					storageService.remove(TRUSTED_DOMAINS_CONTENT_STORAGE_KEY, StorageScope.GLOBAL);
					storageService.store(
						TRUSTED_DOMAINS_STORAGE_KEY,
						JSON.stringify([...trustedDomains, itemToTrust]),
						StorageScope.GLOBAL
					);

					return [...trustedDomains, pickedResult.id];
				}
		}
	}

	return [];
}

async function getRemotes(fileService: IFileService, textFileService: ITextFileService, contextService: IWorkspaceContextService): Promise<string[]> {
	const workspaceUris = contextService.getWorkspace().folders.map(folder => folder.uri);
	const domains = await Promise.all<string[]>(workspaceUris.map(async workspaceUri => {
		const path = workspaceUri.path;
		const uri = workspaceUri.with({ path: `${path !== '/' ? path : ''}/.git/config` });
		const exists = await fileService.exists(uri);
		if (!exists) {
			return [];
		}
		const content = (await (textFileService.read(uri, { acceptTextOnly: true }).catch(() => ({ value: '' })))).value;
		const domains = new Set<string>();
		let match: RegExpExecArray | null;

		const RemoteMatcher = /^\s*url\s*=\s*(?:git@|https:\/\/)github\.com(?::|\/)([^.]*)\.git\s*$/mg;
		while (match = RemoteMatcher.exec(content)) {
			const [domain, repo] = [match[1], match[2]];
			if (domain && repo) {
				domains.add(`https://github.com/${repo}/`);
			}
		}
		return [...domains];
	}));

	const set = domains.reduce((set, list) => list.reduce((set, item) => set.add(item), set), new Set<string>());
	return [...set];
}

export async function readTrustedDomains(accessor: ServicesAccessor) {

	const storageService = accessor.get(IStorageService);
	const productService = accessor.get(IProductService);
	const authenticationService = accessor.get(IAuthenticationService);
	const fileService = accessor.get(IFileService);
	const textFileService = accessor.get(ITextFileService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);

	const defaultTrustedDomains: string[] = productService.linkProtectionTrustedDomains
		? [...productService.linkProtectionTrustedDomains]
		: [];

	let trustedDomains: string[] = [];
	try {
		const trustedDomainsSrc = storageService.get(TRUSTED_DOMAINS_STORAGE_KEY, StorageScope.GLOBAL);
		if (trustedDomainsSrc) {
			trustedDomains = JSON.parse(trustedDomainsSrc);
		}
	} catch (err) { }

	const userDomains = ((await authenticationService.getSessions('github')) ?? [])
		.map(session => session.account.displayName)
		.map(username => `https://github.com/${username}/`);

	const workspaceDomains = await getRemotes(fileService, textFileService, workspaceContextService);

	return {
		defaultTrustedDomains,
		trustedDomains,
		userDomains,
		workspaceDomains
	};
}
