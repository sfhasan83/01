-- Reference data: launch jurisdictions and the permission catalog.

INSERT INTO ref.currencies (code, name, minor_units) VALUES
  ('AED','UAE Dirham',2), ('SAR','Saudi Riyal',2), ('USD','US Dollar',2), ('GBP','Pound Sterling',2),
  ('CAD','Canadian Dollar',2), ('PKR','Pakistani Rupee',2), ('INR','Indian Rupee',2),
  ('AUD','Australian Dollar',2), ('NZD','New Zealand Dollar',2), ('EUR','Euro',2);

INSERT INTO ref.countries (code, name, currency_code) VALUES
  ('AE','United Arab Emirates','AED'), ('SA','Saudi Arabia','SAR'), ('US','United States','USD'),
  ('GB','United Kingdom','GBP'), ('CA','Canada','CAD'), ('PK','Pakistan','PKR'), ('IN','India','INR'),
  ('AU','Australia','AUD'), ('NZ','New Zealand','NZD'),
  ('DE','Germany','EUR'), ('FR','France','EUR'), ('IE','Ireland','EUR'), ('NL','Netherlands','EUR'),
  ('ES','Spain','EUR'), ('IT','Italy','EUR'), ('BE','Belgium','EUR');

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('org.unit.read','org','View organization units and the org chart'),
  ('org.unit.manage','org','Create, rename and move organization units and unit types'),
  ('org.employee.read','org','View employee records in scope'),
  ('org.employee.manage','org','Create and update employee records in scope'),
  ('iam.user.read','iam','View user accounts'),
  ('iam.user.manage','iam','Create, disable and link user accounts'),
  ('iam.role.manage','iam','Create roles and grant permissions to roles'),
  ('iam.assignment.manage','iam','Assign roles to users over a part of the organization'),
  ('iam.delegation.manage','iam','Create delegations of approval authority for any user'),
  ('iam.sod.manage','iam','Maintain segregation-of-duties rules'),
  ('audit.read','audit','Read the audit trail'),
  ('audit.verify','audit','Verify the integrity of the audit hash chain'),
  ('mdm.uom.manage','mdm','Maintain units of measure'),
  ('mdm.item.read','mdm','View items'),
  ('mdm.item.manage','mdm','Create and update items'),
  ('mdm.party.read','mdm','View customers and suppliers'),
  ('mdm.party.manage','mdm','Create customers and suppliers and submit them for approval'),
  ('mdm.party.approve','mdm','Approve activation of customers and suppliers'),
  ('wf.definition.manage','wf','Create and version workflow definitions'),
  ('wf.instance.read','wf','View workflow instances and approval history in scope'),
  ('wf.escalation.run','wf','Run the escalation sweep');
