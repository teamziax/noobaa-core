/* Copyright (C) 2016 NooBaa */

import template from './paginator.html';
import ko from 'knockout';
import numeral from 'numeral';
import { paginationPageSize } from 'config';

class PaginatorViewModel {
    constructor({ itemCount, pageSize, page }) {
        this.sizeOptions = paginationPageSize.options;
        this.pageSize = pageSize;
        this.page = page;

        this.count = ko.pureComputed(() =>
            ko.unwrap(itemCount)
        );

        this.noResults = ko.pureComputed(() =>
            this.count() === 0
        );

        this.pageText = ko.pureComputed(() => {
            const page = this.page() + 1;
            const pageCount  = Math.ceil(this.count() / this.pageSize());
            return `${
                numeral(page).format(',')
            } of ${
                numeral(pageCount).format(',')
            }`;
        });

        this.itemRange = ko.pureComputed(() => {
            const count = this.count() || 0;
            const start = count !== 0 ? (this.page() || 0) * this.pageSize() + 1 : 0;
            const end = Math.min(start + this.pageSize() - 1, count);
            return `${
                numeral(start).format(',')
            } - ${
                numeral(end).format(',')
            }`;
        });

        this.itemCount = ko.pureComputed(() =>
            numeral(this.count() || 0).format(',')
        );

        this.lastPageIndex = ko.pureComputed(() =>
            this.count() > 0 ? Math.floor((this.count() - 1) / this.pageSize()) : 0
        );

        this.isFirstPage = ko.pureComputed(() =>
            this.page() === 0
        );

        this.isLastPage = ko.pureComputed(() =>
            this.page() === this.lastPageIndex()
        );
    }

    onSelectPageSize(pageSize, evt) {
        this.pageSize(pageSize);
        evt.target.blur();
    }


    onJumpToFirstPage() {
        this.page(0);
    }

    onPageForward() {
        if (!this.isLastPage()) {
            this.page(this.page() + 1);
        }
    }

    onPageBackward() {
        if (!this.isFirstPage()) {
            this.page(this.page() - 1);
        }
    }

    onJumpToLastPage() {
        this.page(this.lastPageIndex());
    }
}

export default {
    viewModel: PaginatorViewModel,
    template: template
};
