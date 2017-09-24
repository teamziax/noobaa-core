/* Copyright (C) 2016 NooBaa */

import template from './create-namespace-resource-modal.html';
import Observer from 'observer';
import FormViewModel from 'components/form-view-model';
import { state$, action$ } from 'state';
import ko from 'knockout';
import { getCloudServiceMeta, getCloudTargetTooltip } from 'utils/cloud-utils';
import { validateName } from 'utils/validation-utils';
import { inputThrottle } from 'config';
import {
    fetchCloudTargets,
    updateForm,
    dropCloudTargets,
    closeModal,
    createNamespaceResource
} from 'action-creators';

const formName = 'createNSResourceForm';

class CreateNamespaceResourceModalViewModel extends Observer {
    constructor() {
        super();

        this.connectionOptions = ko.observableArray();
        this.fetchingTargets = ko.observable();
        this.targetOptions = ko.observableArray();
        this.existingNames = null;
        this.nameRestrictionList = ko.observableArray();
        this.form = new FormViewModel({
            name: formName,
            fields: {
                connection: '',
                target: '',
                resourceName: ''
            },
            onValidate: this.onValidate.bind(this),
            onSubmit: this.onSubmit.bind(this)
        });

        this.throttledResourceName = this.form.resourceName
            .throttle(inputThrottle);

        this.observe(
            state$.getMany(
                'accounts',
                'session',
                'namespaceResources',
                'hostPools',
                ['forms', formName],
                'cloudTargets',
            ),
            this.onState
        );
    }

    onState([ accounts, session, namespaceResources, hostPools, form, cloudTargets ]) {
        if (!accounts || !namespaceResources || !hostPools || !form) return;

        const { externalConnections } = accounts[session.user];
        const connectionOptions = externalConnections
            .map(conn => {
                const { icon, selectedIcon } = getCloudServiceMeta(conn.service);
                return {
                    label: conn.name,
                    value: conn.name,
                    remark: conn.identity,
                    icon: icon,
                    selectedIcon: selectedIcon
                };
            });

        const fetchingTargets = cloudTargets.fetching && !cloudTargets.list;
        const targetOptions = (cloudTargets.list || [])
            .map(target => ({
                value: target.name,
                disabled: Boolean(target.usedBy),
                tooltip: {
                    text: getCloudTargetTooltip(target),
                    position: 'after'
                }
            }));

        const { connection, resourceName, target } = form.fields;

        const existingNames = [ ...Object.keys(namespaceResources), ...Object.keys(hostPools) ];
        const nameRestrictionList = validateName(resourceName.value, existingNames)
            .map(result => {
                // Use nocss class to indeicate no css is needed, cannot use empty string
                // because of the use of logical or as condition fallback operator.
                const css =
                    (!connection.value && 'nocss') ||
                    (result.valid && 'success') ||
                    (resourceName.touched && 'error') ||
                    'nocss';

                return {
                    label: result.message,
                    css: css === 'nocss' ? '' : css
                };
            });

        // Load cloud targets of necessary.
        if (connection.value && connection.value !== cloudTargets.connection) {
            action$.onNext(fetchCloudTargets(connection.value));
        }

        // Suggest a name for the resource if the user didn't enter one himself.
        if (!resourceName.touched && target.value && resourceName.value !== target.value) {
            action$.onNext(updateForm(formName, { resourceName: target.value }, false));
        }

        this.connectionOptions(connectionOptions);
        this.fetchingTargets(fetchingTargets);
        this.targetOptions(targetOptions);
        this.existingNames = existingNames;
        this.nameRestrictionList(nameRestrictionList);
    }

    onValidate(values) {
        const { connection, target, resourceName } = values;
        const errors = {};

        if (!connection) {
            errors.connection = 'Please select a connection';

        } else {
            if (!target) {
                errors.target = 'Please select a target bucket';
            }

            const hasNameErrors = validateName(resourceName, this.existingNames)
                .some(rule => !rule.valid);

            if (hasNameErrors) {
                errors.resourceName = '';
            }
        }

        return errors;
    }

    onSubmit(values) {
        const { resourceName, connection, target } = values;
        const action = createNamespaceResource(resourceName, connection, target);
        action$.onNext(action);
        action$.onNext(closeModal());
    }

    onCancel() {
        action$.onNext(closeModal());
    }

    dispose() {
        action$.onNext(dropCloudTargets());
        this.form.dispose();
        super.dispose();
    }
}

export default {
    viewModel: CreateNamespaceResourceModalViewModel,
    template: template
};
