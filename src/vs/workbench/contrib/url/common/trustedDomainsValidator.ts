/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from 'vs/base/common/network';
import Severity from 'vs/base/common/severity';
import { equalsIgnoreCase } from 'vs/base/common/strings';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IProductService } from 'vs/platform/product/common/productService';
import { IQuickInputService } from 'vs/platform/quickinput/common/quickInput';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import {
	configureOpenerTrustedDomainsHandler,
	readTrustedDomains
} from 'vs/workbench/contrib/url/common/trustedDomains';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';

export class OpenerValidatorContributions implements IWorkbenchContribution {
	constructor(
		@IOpenerService private readonly _openerService: IOpenerService,
		@IStorageService private readonly _storageService: IStorageService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IProductService private readonly _productService: IProductService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IEditorService private readonly _editorService: IEditorService,
		@IClipboardService private readonly _clipboardService: IClipboardService
	) {
		this._openerService.registerValidator({ shouldOpen: r => this.validateLink(r) });
	}

	async validateLink(resource: URI): Promise<boolean> {
		const { scheme, authority, path, query, fragment } = resource;

		if (!equalsIgnoreCase(scheme, Schemas.http) && !equalsIgnoreCase(scheme, Schemas.https)) {
			return true;
		}

		const domainToOpen = `${scheme}://${authority}`;
		const { defaultTrustedDomains, trustedDomains } = readTrustedDomains(this._storageService, this._productService);
		const allTrustedDomains = [...defaultTrustedDomains, ...trustedDomains];

		if (isURLDomainTrusted(resource, allTrustedDomains)) {
			return true;
		} else {
			let formattedLink = `${scheme}://${authority}${path}`;

			const linkTail = `${query ? '?' + query : ''}${fragment ? '#' + fragment : ''}`;


			const remainingLength = Math.max(0, 60 - formattedLink.length);
			const linkTailLengthToKeep = Math.min(Math.max(5, remainingLength), linkTail.length);

			if (linkTailLengthToKeep === linkTail.length) {
				formattedLink += linkTail;
			} else {
				// keep the first char ? or #
				// add ... and keep the tail end as much as possible
				formattedLink += linkTail.charAt(0) + '...' + linkTail.substring(linkTail.length - linkTailLengthToKeep + 1);
			}

			const { choice } = await this._dialogService.show(
				Severity.Info,
				localize(
					'openExternalLinkAt',
					'Do you want {0} to open the external website?',
					this._productService.nameShort
				),
				[
					localize('openLink', 'Open Link'),
					localize('copyLink', 'Copy Link'),
					localize('cancel', 'Cancel'),
					localize('configureTrustedDomains', 'Configure Trusted Domains')
				],
				{
					detail: formattedLink,
					cancelId: 2
				}
			);

			// Open Link
			if (choice === 0) {
				return true;
			}
			// Copy Link
			else if (choice === 1) {
				this._clipboardService.writeText(resource.toString(true));
			}
			// Configure Trusted Domains
			else if (choice === 3) {
				const pickedDomains = await configureOpenerTrustedDomainsHandler(
					trustedDomains,
					domainToOpen,
					this._quickInputService,
					this._storageService,
					this._editorService
				);
				// Trust all domains
				if (pickedDomains.indexOf('*') !== -1) {
					return true;
				}
				// Trust current domain
				if (isURLDomainTrusted(resource, pickedDomains)) {
					return true;
				}
				return false;
			}

			return false;
		}
	}
}

const rLocalhost = /^localhost(:\d+)?$/i;
const r127 = /^127.0.0.1(:\d+)?$/;

function isLocalhostAuthority(authority: string) {
	return rLocalhost.test(authority) || r127.test(authority);
}

/**
 * Check whether a domain like https://www.microsoft.com matches
 * the list of trusted domains.
 *
 * - Schemes must match
 * - There's no subdomain matching. For example https://microsoft.com doesn't match https://www.microsoft.com
 * - Star matches all subdomains. For example https://*.microsoft.com matches https://www.microsoft.com and https://foo.bar.microsoft.com
 */
export function isURLDomainTrusted(url: URI, trustedDomains: string[]) {
	if (isLocalhostAuthority(url.authority)) {
		return true;
	}

	const domain = `${url.scheme}://${url.authority}`;

	for (let i = 0; i < trustedDomains.length; i++) {
		if (trustedDomains[i] === '*') {
			return true;
		}

		if (trustedDomains[i] === domain) {
			return true;
		}

		let parsedTrustedDomain;
		if (/^https?:\/\//.test(trustedDomains[i])) {
			parsedTrustedDomain = URI.parse(trustedDomains[i]);
			if (url.scheme !== parsedTrustedDomain.scheme) {
				continue;
			}
		} else {
			parsedTrustedDomain = URI.parse('https://' + trustedDomains[i]);
		}

		if (url.authority === parsedTrustedDomain.authority) {
			return pathMatches(url.path, parsedTrustedDomain.path);
		}

		if (trustedDomains[i].indexOf('*') !== -1) {

			let reversedAuthoritySegments = url.authority.split('.').reverse();
			const reversedTrustedDomainAuthoritySegments = parsedTrustedDomain.authority.split('.').reverse();

			if (
				reversedTrustedDomainAuthoritySegments.length < reversedAuthoritySegments.length &&
				reversedTrustedDomainAuthoritySegments[reversedTrustedDomainAuthoritySegments.length - 1] === '*'
			) {
				reversedAuthoritySegments = reversedAuthoritySegments.slice(0, reversedTrustedDomainAuthoritySegments.length);
			}

			const authorityMatches = reversedAuthoritySegments.every((val, i) => {
				return reversedTrustedDomainAuthoritySegments[i] === '*' || val === reversedTrustedDomainAuthoritySegments[i];
			});

			if (authorityMatches && pathMatches(url.path, parsedTrustedDomain.path)) {
				return true;
			}
		}
	}

	return false;
}

function pathMatches(open: string, rule: string) {
	if (rule === '/') {
		return true;
	}

	const openSegments = open.split('/');
	const ruleSegments = rule.split('/');
	for (let i = 0; i < ruleSegments.length; i++) {
		if (ruleSegments[i] !== openSegments[i]) {
			return false;
		}
	}

	return true;
}
